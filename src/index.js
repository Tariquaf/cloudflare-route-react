/**
 * Generic Cloudflare Worker subpath router/proxy (v4).
 *
 * ROUTES_JSON example (addresses only, no path, no query):
 * {
 *   "/website": "https://website.yourname.workers.dev",
 *   "/delivery": "https://delivery-receipt.yourname.workers.dev"
 * }
 *
 * 1) /delivery/x      -> delivery Worker /x
 * 2) /_proxy/<host>/x -> https://<host>/x
 *    Only for hosts under the same workers.dev account as a
 *    ROUTES_JSON entry. App JavaScript that calls those hosts
 *    directly is rewritten to use /_proxy/<host>, so cookies and
 *    CORS work without extra configuration.
 */

const FILE_EXT =
  "png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|mp3|woff2?|ttf|otf|pdf";

function textResponse(message, status) {
  return new Response(message, {
    status: status,
    headers: { "content-type": "text/plain; charset=UTF-8" }
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Work out which upstream hosts the router may proxy to.
function buildAllowed(routes) {
  const hosts = new Set();
  const suffixes = new Set();

  for (const key of Object.keys(routes)) {
    try {
      const hostname = new URL(String(routes[key])).hostname.toLowerCase();
      hosts.add(hostname);

      const parts = hostname.split(".");
      if (hostname.endsWith(".workers.dev") && parts.length >= 4) {
        suffixes.add(parts.slice(1).join("."));
      }
    } catch (err) {
      // ignore invalid entries
    }
  }

  return { hosts: hosts, suffixes: Array.from(suffixes) };
}

function isAllowedHost(host, allowed) {
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return false;
  }
  if (allowed.hosts.has(host)) {
    return true;
  }
  for (const suffix of allowed.suffixes) {
    if (host.endsWith("." + suffix)) {
      return true;
    }
  }
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Read ROUTES_JSON
    let routes;
    try {
      routes = JSON.parse(env.ROUTES_JSON || "{}");
    } catch (err) {
      return textResponse(
        "ROUTES_JSON is not valid JSON. Check Cloudflare Variables and Secrets.",
        500
      );
    }

    if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
      return textResponse("ROUTES_JSON must contain a JSON object.", 500);
    }

    const allowed = buildAllowed(routes);

    // 2. Decide where this request goes
    let BASE;
    let PREFIX;
    let UPSTREAM;
    let upstreamPath;
    let isProxy = false;

    if (url.pathname.startsWith("/_proxy/")) {
      // ---- Generic proxy mode ----
      const rest = url.pathname.slice("/_proxy/".length);
      const slash = rest.indexOf("/");
      const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();

      if (!isAllowedHost(host, allowed)) {
        return textResponse("Host not allowed", 403);
      }

      isProxy = true;
      PREFIX = "/_proxy/" + host;
      UPSTREAM = "https://" + host;
      upstreamPath = slash === -1 ? "/" : rest.slice(slash);
    } else {
      // ---- Subpath route mode ----
      BASE = Object.keys(routes)
        .filter(function (path) {
          return (
            url.pathname === path || url.pathname.startsWith(path + "/")
          );
        })
        .sort(function (a, b) {
          return b.length - a.length;
        })[0];

      if (BASE) {
        PREFIX = BASE;
        UPSTREAM = String(routes[BASE]).replace(/\/+$/, "");

        if (url.pathname === BASE || url.pathname === BASE + "/") {
          upstreamPath = "/";
        } else {
          upstreamPath = url.pathname.slice(BASE.length);
          if (!upstreamPath.startsWith("/")) {
            upstreamPath = "/" + upstreamPath;
          }
        }
      } else if (env.DEFAULT_UPSTREAM) {
        UPSTREAM = String(env.DEFAULT_UPSTREAM).replace(/\/+$/, "");
        upstreamPath = url.pathname;
      } else {
        return textResponse("Not found", 404);
      }
    }

    const targetUrl = UPSTREAM + upstreamPath + url.search;

    // 3. Forward request
    let response;
    try {
      const upstreamHeaders = new Headers(request.headers);

      // For rewritten sites, never let upstream answer 304 with no body.
      if (!isProxy) {
        upstreamHeaders.delete("if-none-match");
        upstreamHeaders.delete("if-modified-since");
      }

      response = await fetch(
        new Request(targetUrl, {
          method: request.method,
          headers: upstreamHeaders,
          body: request.body,
          redirect: request.redirect
        })
      );
    } catch (err) {
      return textResponse("Unable to reach upstream application.", 502);
    }

    const contentType = response.headers.get("content-type") || "";

    // 4. Copy headers
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("x-router-version", "4");

    // Helper: root path that still needs the prefix?
    const needsPrefix = function (value) {
      return (
        PREFIX &&
        value &&
        value.startsWith("/") &&
        !value.startsWith("//") &&
        value !== PREFIX &&
        !value.startsWith(PREFIX + "/")
      );
    };

    // 5. Rewrite redirects
    const location = headers.get("location");
    if (location) {
      if (needsPrefix(location)) {
        headers.set("location", PREFIX + location);
      } else if (/^https?:\/\//i.test(location)) {
        try {
          const loc = new URL(location);
          const rest = loc.pathname + loc.search + loc.hash;

          if (PREFIX && loc.host === new URL(UPSTREAM).host) {
            headers.set("location", PREFIX + rest);
          } else if (isAllowedHost(loc.hostname.toLowerCase(), allowed)) {
            headers.set(
              "location",
              url.origin + "/_proxy/" + loc.hostname.toLowerCase() + rest
            );
          }
        } catch (err) {
          // leave location unchanged
        }
      }
    }

    // 6. Rewrite Set-Cookie (scope to prefix, drop Domain)
    if (PREFIX && typeof headers.getSetCookie === "function") {
      const cookies = headers.getSetCookie();
      if (cookies.length > 0) {
        headers.delete("set-cookie");
        for (const cookie of cookies) {
          let rewritten = cookie.replace(/;\s*Domain=[^;]*/i, "");

          if (/;\s*Path=/i.test(rewritten)) {
            rewritten = rewritten.replace(
              /;\s*Path=\//i,
              "; Path=" + PREFIX + "/"
            );
          } else {
            rewritten = rewritten + "; Path=" + PREFIX + "/";
          }

          headers.append("set-cookie", rewritten);
        }
      }
    }

    // Proxy mode: no body rewriting
    if (isProxy || !BASE) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    }

    // 7. HTML rewriting
    if (contentType.includes("text/html")) {
      const rewriteAttribute = function (attribute) {
        return {
          element(el) {
            const value = el.getAttribute(attribute);
            if (needsPrefix(value)) {
              el.setAttribute(attribute, BASE + value);
            }
          }
        };
      };

      const htmlResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });

      return new HTMLRewriter()
        .on("[src]", rewriteAttribute("src"))
        .on("[href]", rewriteAttribute("href"))
        .on("[action]", rewriteAttribute("action"))
        .on("[poster]", rewriteAttribute("poster"))
        .transform(htmlResponse);
    }

    // 8. JavaScript rewriting
    if (
      contentType.includes("javascript") ||
      contentType.includes("ecmascript")
    ) {
      let body = await response.text();

      // 8a. Calls to your other Workers go through /_proxy/<host>
      for (const suffix of allowed.suffixes) {
        const hostRegex = new RegExp(
          "https?:\\/\\/([a-z0-9-]+\\." + escapeRegex(suffix) + ")",
          "gi"
        );
        body = body.replace(hostRegex, function (match, host) {
          return url.origin + "/_proxy/" + host.toLowerCase();
        });
      }

      // 8b. Root-relative file paths (images, fonts, video, pdf)
      const fileRegex = new RegExp(
        "([\"'`(])\\/(?!\\/)([^\"'`()\\s\\\\]*\\.(?:" +
          FILE_EXT +
          "))(?![A-Za-z0-9_])",
        "gi"
      );

      body = body.replace(fileRegex, function (match, open, rest) {
        const full = "/" + rest;
        if (full === BASE || full.startsWith(BASE + "/")) {
          return match;
        }
        if (full.startsWith("/_proxy/")) {
          return match;
        }
        return open + BASE + full;
      });

      headers.set("cache-control", "no-cache");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    }

    // 9. CSS rewriting
    if (contentType.includes("text/css")) {
      let body = await response.text();

      body = body.replace(
        /url\(\s*(["']?)\/(?!\/)([^)"']+)\1\s*\)/g,
        function (match, quote, rest) {
          const full = "/" + rest;
          if (full === BASE || full.startsWith(BASE + "/")) {
            return match;
          }
          return "url(" + quote + BASE + full + quote + ")";
        }
      );

      headers.set("cache-control", "no-cache");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    }

    // 10. Everything else passes through
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  }
};
