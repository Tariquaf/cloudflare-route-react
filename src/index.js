/**
 * Generic Cloudflare Worker subpath router/proxy
 *
 * Examples:
 *
 * /verification/          -> verification Worker
 * /verification/api/...   -> verification Worker /api/...
 *
 * /rice/                  -> rice Worker
 * /rice/api/...           -> rice Worker /api/...
 *
 * ROUTES_JSON example:
 *
 * {
 *   "/verification": "https://verification.usman-agro7c.workers.dev",
 *   "/rice": "https://rice-xxxxx.workers.dev"
 * }
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ============================================================
    // 1. Read routing configuration
    // ============================================================

    let routes;

    try {
      routes = JSON.parse(env.ROUTES_JSON || "{}");
    } catch (err) {
      return new Response(
        "ROUTES_JSON is not valid JSON. Check Cloudflare Variables and Secrets.",
        {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=UTF-8"
          }
        }
      );
    }

    // ============================================================
    // 2. Find the longest matching application path
    // ============================================================

    const BASE = Object.keys(routes)
      .filter((p) => {
        return (
          url.pathname === p ||
          url.pathname.startsWith(p + "/")
        );
      })
      .sort((a, b) => b.length - a.length)[0];

    // ============================================================
    // 3. Determine upstream Worker
    // ============================================================

    let UPSTREAM;

    if (BASE) {
      UPSTREAM = String(routes[BASE]).replace(/\/+$/, "");
    } else if (env.DEFAULT_UPSTREAM) {
      UPSTREAM = String(env.DEFAULT_UPSTREAM).replace(/\/+$/, "");
    } else {
      return new Response("Not found", {
        status: 404
      });
    }

    // ============================================================
    // 4. Remove application prefix before forwarding upstream
    // ============================================================

    let upstreamPath = url.pathname;

    if (BASE) {
      if (
        upstreamPath === BASE ||
        upstreamPath === BASE + "/"
      ) {
        upstreamPath = "/";
      } else {
        upstreamPath = upstreamPath.slice(BASE.length);

        if (!upstreamPath.startsWith("/")) {
          upstreamPath = "/" + upstreamPath;
        }
      }
    }

    const targetUrl =
      UPSTREAM +
      upstreamPath +
      url.search;

    // ============================================================
    // 5. Forward request
    // ============================================================

    const upstreamRequest = new Request(
      targetUrl,
      request
    );

    let response;

    try {
      response = await fetch(upstreamRequest);
    } catch (err) {
      return new Response(
        "Upstream request failed.",
        {
          status: 502,
          headers: {
            "content-type": "text/plain; charset=UTF-8"
          }
        }
      );
    }

    const contentType =
      response.headers.get("content-type") || "";

    // ============================================================
    // 6. Copy response headers
    // ============================================================

    const headers = new Headers(response.headers);

    // We modify response bodies below, so these are no longer valid.
    headers.delete("content-length");
    headers.delete("content-encoding");

    // ============================================================
    // 7. Rewrite redirects
    //
    // Example upstream:
    //
    // Location: /login
    //
    // becomes:
    //
    // Location: /verification/login
    // ============================================================

    if (BASE) {
      const location = headers.get("location");

      if (
        location &&
        location.startsWith("/") &&
        !location.startsWith("//") &&
        !location.startsWith(BASE + "/") &&
        location !== BASE
      ) {
        headers.set(
          "location",
          BASE + location
        );
      }
    }

    // ============================================================
    // 8. Rewrite cookies
    //
    // Important for API applications using authentication/session
    // cookies.
    //
    // Upstream:
    //
    // Set-Cookie: session=abc; Path=/; HttpOnly
    //
    // becomes:
    //
    // Set-Cookie: session=abc; Path=/verification; HttpOnly
    // ============================================================

    if (BASE) {
      const cookies = headers.getSetCookie
        ? headers.getSetCookie()
        : [];

      if (cookies.length > 0) {
        headers.delete("set-cookie");

        for (const cookie of cookies) {
          const rewrittenCookie = cookie.replace(
            /;\s*Path=\//i,
            `; Path=${BASE}/`
          );

          headers.append(
            "set-cookie",
            rewrittenCookie
          );
        }
      }
    }

    // ============================================================
    // 9. HTML
    //
    // Rewrite:
    //
    // /assets/app.js
    //
    // to:
    //
    // /verification/assets/app.js
    //
    // Also handles href/src/preload/etc.
    // ============================================================

    if (
      BASE &&
      contentType.includes("text/html")
    ) {
      const rewriteAttribute = (attribute) => ({
        element(el) {
          const value =
            el.getAttribute(attribute);

          if (
            value &&
            value.startsWith("/") &&
            !value.startsWith("//") &&
            value !== BASE &&
            !value.startsWith(BASE + "/")
          ) {
            el.setAttribute(
              attribute,
              BASE + value
            );
          }
        }
      });

      return new HTMLRewriter()
        .on("[src]", rewriteAttribute("src"))
        .on("[href]", rewriteAttribute("href"))
        .on("[action]", rewriteAttribute("action"))
        .transform(
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
          })
        );
    }

    // ============================================================
    // 10. JavaScript
    //
    // This is the important part for API-enabled SPAs.
    //
    // Example:
    //
    // fetch("/api/products")
    //
    // becomes:
    //
    // fetch("/verification/api/products")
    //
    // Also catches:
    //
    // axios.get("/api/products")
    // new URL("/api/products", ...)
    // "/images/photo.jpg"
    // "/data/config.json"
    // `/api/products/${id}`
    //
    // External URLs such as:
    //
    // https://api.example.com/...
    //
    // are NOT changed.
    // ============================================================

    if (
      BASE &&
      (
        contentType.includes("javascript") ||
        contentType.includes("application/javascript") ||
        contentType.includes("text/javascript") ||
        contentType.includes("application/x-javascript")
      )
    ) {
      let body = await response.text();

      const escapedBase =
        BASE.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      // ----------------------------------------------------------
      // Double-quoted strings
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          `(["])\\/(?!\\/|${escapedBase}(?:\\/|"))`,
          "g"
        ),
        `$1${BASE}/`
      );

      // ----------------------------------------------------------
      // Single-quoted strings
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          `(['])\\/(?!\\/|${escapedBase}(?:\\/|'))`,
          "g"
        ),
        `$1${BASE}/`
      );

      // ----------------------------------------------------------
      // Template literals
      //
      // `/api/${id}`
      //
      // becomes:
      //
      // `/verification/api/${id}`
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          "(`)\\/(?!\\/|" +
          escapedBase +
          "(?:\\/|`))",
          "g"
        ),
        `$1${BASE}/`
      );

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // ============================================================
    // 11. CSS
    //
    // Rewrite:
    //
    // url("/images/logo.svg")
    //
    // to:
    //
    // url("/verification/images/logo.svg")
    // ============================================================

    if (
      BASE &&
      contentType.includes("text/css")
    ) {
      let body = await response.text();

      const escapedBase =
        BASE.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      body = body.replace(
        new RegExp(
          `url\$begin:math:text$\\\\s\*\(\[\"\'\]\?\)\\\\\/\(\?\!\\\\\/\|\$\{escapedBase\}\\\\\/\)\(\[\^\)\"\'\]\+\)\\\\1\\\\s\*\\$end:math:text$`,
          "g"
        ),
        `url($1${BASE}/$2$1)`
      );

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // ============================================================
    // 12. Everything else passes through unchanged
    // ============================================================

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
