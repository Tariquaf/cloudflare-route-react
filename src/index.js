/**
 * Generic subpath router/proxy for Cloudflare Workers.
 *
 * Example:
 *
 * /test                    -> Rice website
 * /test/api/...            -> Rice API
 * /verification            -> Verification website
 * /verification/api/...   -> Verification API
 * /blog                    -> Blog website
 *
 * ROUTES_JSON controls everything.
 *
 * Example:
 *
 * {
 *   "/test": "https://rice-xxxxx.workers.dev",
 *   "/verification": "https://verification-xxxxx.workers.dev",
 *   "/blog": "https://blog-xxxxx.workers.dev"
 * }
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ============================================================
    // 1. Read routes
    // ============================================================

    let routes;

    try {
      routes = JSON.parse(env.ROUTES_JSON || "{}");
    } catch (err) {
      return new Response(
        "ROUTES_JSON is not valid JSON. Check Cloudflare Variables and Secrets.",
        { status: 500 }
      );
    }

    // ============================================================
    // 2. Find longest matching route
    // ============================================================

    const BASE = Object.keys(routes)
      .filter(
        (p) =>
          url.pathname === p ||
          url.pathname.startsWith(p + "/")
      )
      .sort((a, b) => b.length - a.length)[0];

    // ============================================================
    // 3. Determine upstream
    // ============================================================

    let UPSTREAM;

    if (BASE) {
      UPSTREAM = String(routes[BASE]).replace(/\/$/, "");
    } else if (env.DEFAULT_UPSTREAM) {
      UPSTREAM = String(env.DEFAULT_UPSTREAM).replace(/\/$/, "");
    } else {
      return new Response("Not found", {
        status: 404
      });
    }

    // ============================================================
    // 4. Special runtime script
    //
    // This script is injected into path-mounted HTML.
    //
    // It catches API calls such as:
    //
    // fetch("/api/products")
    //
    // even when the URL is constructed dynamically and therefore
    // cannot be detected by our JavaScript text replacement.
    //
    // Browser:
    //
    // /api/products
    //
    // becomes:
    //
    // /test/api/products
    //
    // The normal router then strips /test and sends:
    //
    // /api/products
    //
    // to the developer Worker.
    // ============================================================

    if (
      BASE &&
      url.pathname === BASE + "/__router-runtime.js"
    ) {
      const runtime = `
(() => {
  const BASE = ${JSON.stringify(BASE)};

  function rewriteURL(input) {
    // ----------------------------------------------------------
    // String URL
    // ----------------------------------------------------------

    if (typeof input === "string") {
      if (
        input.startsWith("/") &&
        !input.startsWith("//") &&
        !input.startsWith(BASE + "/") &&
        input !== BASE
      ) {
        return BASE + input;
      }

      return input;
    }

    // ----------------------------------------------------------
    // URL object
    // ----------------------------------------------------------

    if (input instanceof URL) {
      if (
        input.origin === window.location.origin &&
        input.pathname.startsWith("/") &&
        !input.pathname.startsWith(BASE + "/") &&
        input.pathname !== BASE
      ) {
        const copy = new URL(input.href);

        copy.pathname =
          BASE +
          (
            copy.pathname === "/"
              ? ""
              : copy.pathname
          );

        return copy;
      }

      return input;
    }

    return input;
  }

  // ============================================================
  // Intercept fetch()
  // ============================================================

  const originalFetch = window.fetch;

  window.fetch = function(input, init) {
    try {
      if (typeof input === "string") {
        input = rewriteURL(input);
      } else if (input instanceof URL) {
        input = rewriteURL(input);
      } else if (input instanceof Request) {
        const rewritten = rewriteURL(input.url);

        if (rewritten !== input.url) {
          input = new Request(rewritten, input);
        }
      }
    } catch (e) {
      // Never break the application because of the router.
    }

    return originalFetch.call(this, input, init);
  };

  // ============================================================
  // Intercept XMLHttpRequest
  // ============================================================

  const originalOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function(
    method,
    requestURL,
    async,
    username,
    password
  ) {
    try {
      requestURL = rewriteURL(requestURL);
    } catch (e) {
      // Leave the original URL untouched.
    }

    return originalOpen.call(
      this,
      method,
      requestURL,
      async,
      username,
      password
    );
  };
})();
`;

      return new Response(runtime, {
        status: 200,
        headers: {
          "content-type": "application/javascript; charset=UTF-8",
          "cache-control": "public, max-age=300"
        }
      });
    }

    // ============================================================
    // 5. Remove matched subpath before forwarding
    //
    // /test
    //        -> /
    //
    // /test/
    //        -> /
    //
    // /test/api/products
    //        -> /api/products
    //
    // /test/images/v2.jpg
    //        -> /images/v2.jpg
    // ============================================================

    let path = url.pathname;

    if (BASE) {
      path =
        path === BASE || path === BASE + "/"
          ? "/"
          : path.slice(BASE.length);
    }

    const targetUrl =
      UPSTREAM +
      path +
      url.search;

    // ============================================================
    // 6. Forward request
    // ============================================================

    const upstreamRequest = new Request(
      targetUrl,
      request
    );

    const response = await fetch(upstreamRequest);

    const contentType =
      response.headers.get("content-type") || "";

    // ============================================================
    // 7. Rewrite HTML
    //
    // Root-relative resources:
    //
    // /assets/app.js
    //        ->
    // /test/assets/app.js
    //
    // /brand/logo.svg
    //        ->
    // /test/brand/logo.svg
    //
    // Also inject the runtime API interceptor.
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

        // Rewrite src=""
        .on(
          "[src]",
          rewriteAttribute("src")
        )

        // Rewrite href=""
        .on(
          "[href]",
          rewriteAttribute("href")
        )

        // Inject our generic runtime before </head>
        .on("head", {
          element(el) {
            el.append(
              `<script src="${BASE}/__router-runtime.js"></script>`,
              {
                html: true
              }
            );
          }
        })

        .transform(response);
    }

    // ============================================================
    // 8. Rewrite JavaScript
    //
    // This remains as an additional layer.
    //
    // It handles literal URLs such as:
    //
    // "/api/products"
    // "/images/v2.jpg"
    // "/brand/logo.svg"
    // "/data/products.json"
    //
    // The runtime interceptor above handles dynamically
    // constructed API URLs.
    // ============================================================

    if (
      BASE &&
      (
        contentType.includes("javascript") ||
        contentType.includes("application/javascript") ||
        contentType.includes("text/javascript")
      )
    ) {
      let body = await response.text();

      const baseNoSlash = BASE
        .slice(1)
        .replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      const jsRewrite = new RegExp(
        `(["'\`])\\/(?!\\/|${baseNoSlash}\\/)([^"'\\\`?#]+)([?#]?[^"'\\\`]*)\\1`,
        "g"
      );

      body = body.replace(
        jsRewrite,
        `$1${BASE}/$2$3$1`
      );

      const headers =
        new Headers(response.headers);

      headers.delete("content-length");
      headers.delete("content-encoding");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // ============================================================
    // 9. Rewrite CSS
    //
    // url("/images/background.jpg")
    //
    // becomes:
    //
    // url("/test/images/background.jpg")
    // ============================================================

    if (
      BASE &&
      contentType.includes("text/css")
    ) {
      let body = await response.text();

      const baseNoSlash = BASE
        .slice(1)
        .replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      const cssRewrite = new RegExp(
        `url\\(\\s*(["']?)\\/(?!\\/|${baseNoSlash}\\/)([^)"']+)\\1\\s*\\)`,
        "g"
      );

      body = body.replace(
        cssRewrite,
        `url($1${BASE}/$2$1)`
      );

      const headers =
        new Headers(response.headers);

      headers.delete("content-length");
      headers.delete("content-encoding");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // ============================================================
    // 10. Everything else passes through unchanged
    // ============================================================

    return response;
  }
};
