/**
 * Generic Cloudflare Worker subpath router/proxy.
 *
 * ROUTES_JSON example:
 * {
 *   "/website": "https://website.yourname.workers.dev",
 *   "/verification": "https://verification.yourname.workers.dev"
 * }
 *
 * /website/images/a.jpg -> website Worker /images/a.jpg
 */

const FILE_EXT =
  "png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|mp3|woff2?|ttf|otf|pdf";

function textResponse(message, status) {
  return new Response(message, {
    status: status,
    headers: { "content-type": "text/plain; charset=UTF-8" }
  });
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

    // 2. Longest matching route
    const BASE = Object.keys(routes)
      .filter(function (path) {
        return (
          url.pathname === path || url.pathname.startsWith(path + "/")
        );
      })
      .sort(function (a, b) {
        return b.length - a.length;
      })[0];

    // 3. Upstream
    let UPSTREAM;
    if (BASE) {
      UPSTREAM = String(routes[BASE]).replace(/\/+$/, "");
    } else if (env.DEFAULT_UPSTREAM) {
      UPSTREAM = String(env.DEFAULT_UPSTREAM).replace(/\/+$/, "");
    } else {
      return textResponse("Not found", 404);
    }

    // 4. Strip the prefix
    let upstreamPath = url.pathname;
    if (BASE) {
      if (upstreamPath === BASE || upstreamPath === BASE + "/") {
        upstreamPath = "/";
      } else {
        upstreamPath = upstreamPath.slice(BASE.length);
        if (!upstreamPath.startsWith("/")) {
          upstreamPath = "/" + upstreamPath;
        }
      }
    }

    const targetUrl = UPSTREAM + upstreamPath + url.search;

    // 5. Forward request (without conditional headers, so upstream
    //    never answers 304 and we always get a body to rewrite)
    let response;
    try {
      const upstreamHeaders = new Headers(request.headers);
      upstreamHeaders.delete("if-none-match");
      upstreamHeaders.delete("if-modified-since");

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

    // 6. Copy headers
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("x-router-version", "3");
    headers.set("x-router-target", targetUrl);
    headers.set("x-router-upstream-status", String(response.status));

    // Helper: is this a root path that still needs the prefix?
    const needsPrefix = function (value) {
      return (
        BASE &&
        value &&
        value.startsWith("/") &&
        !value.startsWith("//") &&
        value !== BASE &&
        !value.startsWith(BASE + "/")
      );
    };

    // 7. Rewrite redirects
    if (BASE) {
      const location = headers.get("location");
      if (needsPrefix(location)) {
        headers.set("location", BASE + location);
      }
    }

    // 8. Rewrite Set-Cookie Path
    if (BASE && typeof headers.getSetCookie === "function") {
      const cookies = headers.getSetCookie();
      if (cookies.length > 0) {
        headers.delete("set-cookie");
        for (const cookie of cookies) {
          headers.append(
            "set-cookie",
            cookie.replace(/;\s*Path=\//i, "; Path=" + BASE + "/")
          );
        }
      }
    }

    // 9. HTML rewriting
    if (BASE && contentType.includes("text/html")) {
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

    // 10. JavaScript: prefix root paths that point to FILES
    //     (images, video, fonts, pdf), whether written as "/x.jpg",
    //     '/x.jpg', `/x.jpg` or url(/x.jpg). Route paths are never changed.
    if (
      BASE &&
      (contentType.includes("javascript") ||
        contentType.includes("ecmascript"))
    ) {
      let body = await response.text();

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
        return open + BASE + full;
      });

      headers.set("cache-control", "no-cache");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    }

    // 11. CSS rewriting
    if (BASE && contentType.includes("text/css")) {
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

    // 12. Everything else passes through
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  }
};
