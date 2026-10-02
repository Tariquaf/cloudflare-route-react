/**
 * Generic Cloudflare Worker subpath router/proxy.
 *
 * Example ROUTES_JSON:
 *
 * {
 *   "/verification": "https://verification.usman-agro7c.workers.dev",
 *   "/rice": "https://rice-xxxxx.workers.dev",
 *   "/blog": "https://blog-xxxxx.workers.dev"
 * }
 *
 * Requests:
 *
 *   /verification/
 *       -> verification Worker /
 *
 *   /verification/assets/app.js
 *       -> verification Worker /assets/app.js
 *
 *   /verification/api/verify
 *       -> verification Worker /api/verify
 *
 *   /rice/images/v1.jpg
 *       -> rice Worker /images/v1.jpg
 *
 * The router does NOT need to know whether something is:
 *
 *   /api
 *   /assets
 *   /images
 *   /data
 *   /brand
 *   /anything
 *
 * Everything belonging to the application is handled by its
 * configured base path.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ============================================================
    // 1. Read ROUTES_JSON
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

    // Make sure we have an object.
    if (
      !routes ||
      typeof routes !== "object" ||
      Array.isArray(routes)
    ) {
      return new Response(
        "ROUTES_JSON must contain a JSON object.",
        {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=UTF-8"
          }
        }
      );
    }

    // ============================================================
    // 2. Find the longest matching route
    // ============================================================
    //
    // Example:
    //
    // /verification
    // /verification/admin
    //
    // For:
    //
    // /verification/admin/users
    //
    // /verification/admin wins because it is the longest match.
    // ============================================================

    const BASE = Object.keys(routes)
      .filter((path) => {
        return (
          url.pathname === path ||
          url.pathname.startsWith(path + "/")
        );
      })
      .sort((a, b) => b.length - a.length)[0];

    // ============================================================
    // 3. Determine upstream
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
    // 4. Remove the application prefix
    // ============================================================
    //
    // Public:
    //
    // /verification/api/test
    //
    // becomes upstream:
    //
    // /api/test
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

    let response;

    try {
      const upstreamRequest = new Request(
        targetUrl,
        request
      );

      response = await fetch(upstreamRequest);
    } catch (err) {
      return new Response(
        "Unable to reach upstream application.",
        {
          status: 502,
          headers: {
            "content-type": "text/plain; charset=UTF-8"
          }
        }
      );
    }

    // ============================================================
    // 6. Content type
    // ============================================================

    const contentType =
      response.headers.get("content-type") || "";

    // ============================================================
    // 7. Copy headers
    // ============================================================

    const headers = new Headers(response.headers);

    // We may modify the body below.
    // These headers must not describe the old body.
    headers.delete("content-length");
    headers.delete("content-encoding");

    // ============================================================
    // 8. Rewrite redirects
    // ============================================================
    //
    // Upstream:
    //
    // Location: /login
    //
    // Public:
    //
    // Location: /verification/login
    //
    // This is important for authentication-enabled applications.
    // ============================================================

    if (BASE) {
      const location = headers.get("location");

      if (
        location &&
        location.startsWith("/") &&
        !location.startsWith("//") &&
        location !== BASE &&
        !location.startsWith(BASE + "/")
      ) {
        headers.set(
          "location",
          BASE + location
        );
      }
    }

    // ============================================================
    // 9. Rewrite Set-Cookie Path
    // ============================================================
    //
    // Upstream:
    //
    // Set-Cookie: session=abc; Path=/; HttpOnly
    //
    // becomes:
    //
    // Set-Cookie: session=abc; Path=/verification/; HttpOnly
    //
    // This is needed by some API/authentication applications.
    // ============================================================

    if (BASE) {
      let cookies = [];

      if (typeof headers.getSetCookie === "function") {
        cookies = headers.getSetCookie();
      }

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
    // 10. HTML rewriting
    // ============================================================
    //
    // Handles:
    //
    //   <script src="/assets/app.js">
    //   <link href="/assets/app.css">
    //   <img src="/images/logo.svg">
    //   <a href="/login">
    //   <form action="/api/login">
    //
    // becoming:
    //
    //   /verification/assets/app.js
    //   /verification/assets/app.css
    //   /verification/images/logo.svg
    //   /verification/login
    //   /verification/api/login
    // ============================================================

    if (
      BASE &&
      contentType.includes("text/html")
    ) {
      const rewriteAttribute = (attribute) => ({
        element(el) {
          const value = el.getAttribute(attribute);

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

      const htmlResponse = new Response(
        response.body,
        {
          status: response.status,
          statusText: response.statusText,
          headers
        }
      );

      return new HTMLRewriter()
        .on("[src]", rewriteAttribute("src"))
        .on("[href]", rewriteAttribute("href"))
        .on("[action]", rewriteAttribute("action"))
        .transform(htmlResponse);
    }

    // ============================================================
    // 11. JavaScript rewriting
    // ============================================================
    //
    // This is the main API-related fix.
    //
    // Example:
    //
    // fetch("/api/verify")
    //
    // becomes:
    //
    // fetch("/verification/api/verify")
    //
    // Also handles:
    //
    // axios.get("/api/verify")
    // fetch("/data/config.json")
    // "/images/logo.svg"
    // `/api/document/${id}`
    //
    // External URLs are NOT changed:
    //
    // https://api.example.com/verify
    // //cdn.example.com/file.js
    //
    // ------------------------------------------------------------
    //
    // Stage 2:
    //
    // We also handle common URL construction patterns such as:
    //
    // new URL("/api/test", ...)
    //
    // because the root-relative string itself is rewritten.
    //
    // We deliberately do NOT attempt to parse JavaScript with a
    // regex-based full parser. The goal is to make minimal changes
    // to Vite-generated bundles while preserving valid JavaScript.
    // ============================================================

    if (
      BASE &&
      (
        contentType.includes("javascript") ||
        contentType.includes("ecmascript") ||
        contentType.includes("x-javascript")
      )
    ) {
      let body = await response.text();

      const escapedBase =
        BASE.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      // ----------------------------------------------------------
      // Stage 1:
      // Double-quoted root-relative strings
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          '(["])\\/(?!\\/|' +
          escapedBase +
          '(?:\\/|"))',
          "g"
        ),
        '$1' + BASE + "/"
      );

      // ----------------------------------------------------------
      // Stage 1:
      // Single-quoted root-relative strings
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          "(['])\\/(?!\\/|" +
          escapedBase +
          "(?:\\/|'))",
          "g"
        ),
        "$1" + BASE + "/"
      );

      // ----------------------------------------------------------
      // Stage 1:
      // Template literals
      //
      // Example:
      //
      // `/api/users/${id}`
      //
      // becomes:
      //
      // `/verification/api/users/${id}`
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          "(`)\\/(?!\\/|" +
          escapedBase +
          "(?:\\/|`))",
          "g"
        ),
        "$1" + BASE + "/"
      );

      // ----------------------------------------------------------
      // Stage 2:
      //
      // Some generated applications may contain strings written
      // with escaped slashes:
      //
      // "\\/api/test"
      //
      // Handle those as well.
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          '(["\'])\\\\\\/(?!\\\\\\/|' +
          escapedBase +
          '(?:\\\\\\/|["\']))',
          "g"
        ),
        "$1\\/" + BASE + "/"
      );

      // ----------------------------------------------------------
      // Stage 2:
      //
      // Handle root-relative URLs inside common URL objects:
      //
      // new URL("/api/test", ...)
      //
      // The string rewrite above normally catches this already,
      // but keeping this explicit makes the intention clear and
      // provides a fallback for slightly unusual generated code.
      // ----------------------------------------------------------

      body = body.replace(
        new RegExp(
          '(new\\s+URL\\(\\s*["\'])\\/(?!\\/|' +
          escapedBase +
          '\\/)',
          "g"
        ),
        "$1" + BASE + "/"
      );

      // ----------------------------------------------------------
      // Stage 2:
      //
      // Common XMLHttpRequest.open:
      //
      // xhr.open("GET", "/api/test")
      //
      // is already covered by the string rewrite above.
      //
      // No additional transformation is necessary.
      // ----------------------------------------------------------

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // ============================================================
    // 12. CSS rewriting
    // ============================================================
    //
    // Example:
    //
    // url("/images/logo.svg")
    //
    // becomes:
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
          `url\\(\\s*(["']?)\\/(?!\\/|${escapedBase}\\/)([^)"']+)\\1\\s*\\)`,
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
    // 13. Everything else passes through unchanged
    // ============================================================

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
