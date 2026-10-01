/**
 * Generic subpath router/proxy for Cloudflare Workers.
 *
 * Example:
 *
 * /test        -> Rice website
 * /test/api    -> Rice API
 * /blog        -> Blog website
 *
 * ROUTES_JSON controls everything.
 *
 * Example ROUTES_JSON:
 *
 * {
 *   "/test": "https://rice-xxxxx.workers.dev",
 *   "/blog": "https://blog-xxxxx.workers.dev"
 * }
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ------------------------------------------------------------
    // 1. Read routes
    // ------------------------------------------------------------

    let routes;

    try {
      routes = JSON.parse(env.ROUTES_JSON || "{}");
    } catch (err) {
      return new Response(
        "ROUTES_JSON is not valid JSON. Check Cloudflare Variables and Secrets.",
        { status: 500 }
      );
    }

    // ------------------------------------------------------------
    // 2. Find longest matching route
    // ------------------------------------------------------------

    const BASE = Object.keys(routes)
      .filter(
        (p) =>
          url.pathname === p ||
          url.pathname.startsWith(p + "/")
      )
      .sort((a, b) => b.length - a.length)[0];

    // ------------------------------------------------------------
    // 3. Determine upstream
    // ------------------------------------------------------------

    let UPSTREAM;

    if (BASE) {
      UPSTREAM = routes[BASE].replace(/\/$/, "");
    } else if (env.DEFAULT_UPSTREAM) {
      UPSTREAM = env.DEFAULT_UPSTREAM.replace(/\/$/, "");
    } else {
      return new Response("Not found", { status: 404 });
    }

    // ------------------------------------------------------------
    // 4. Remove the matched subpath
    //
    // /test
    //       -> /
    //
    // /test/
    //       -> /
    //
    // /test/api/products
    //       -> /api/products
    //
    // /test/images/v2.jpg
    //       -> /images/v2.jpg
    // ------------------------------------------------------------

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

    // ------------------------------------------------------------
    // 5. Forward request
    // ------------------------------------------------------------

    const upstreamRequest = new Request(
      targetUrl,
      request
    );

    const response = await fetch(upstreamRequest);

    const contentType =
      response.headers.get("content-type") || "";

    // ------------------------------------------------------------
    // 6. Rewrite HTML
    //
    // Example:
    //
    // /assets/app.js
    //       ->
    // /test/assets/app.js
    //
    // /brand/logo.svg
    //       ->
    // /test/brand/logo.svg
    // ------------------------------------------------------------

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
        .on(
          "[src]",
          rewriteAttribute("src")
        )
        .on(
          "[href]",
          rewriteAttribute("href")
        )
        .transform(response);
    }

    // ------------------------------------------------------------
    // 7. Rewrite JavaScript
    //
    // This is the important part for APIs.
    //
    // Developer code such as:
    //
    // fetch("/api/products")
    //
    // becomes:
    //
    // fetch("/test/api/products")
    //
    // We do NOT need to know whether an API exists.
    //
    // The same mechanism also handles:
    //
    // "/images/v2.jpg"
    // "/brand/logo.svg"
    // "/assets/..."
    // "/data/..."
    // "/api/..."
    // ------------------------------------------------------------

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

      /*
       * Match quoted root-relative URLs:
       *
       * "/api/products"
       * "/images/v2.jpg"
       * '/brand/logo.svg'
       * `/data/file.json`
       *
       * Do not modify:
       *
       * "//example.com/..."
       * "/test/..."
       */

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

      /*
       * The body has changed.
       *
       * These headers may now contain incorrect values.
       */

      headers.delete("content-length");
      headers.delete("content-encoding");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // ------------------------------------------------------------
    // 8. Rewrite CSS
    //
    // Example:
    //
    // url("/images/background.jpg")
    //
    // becomes:
    //
    // url("/test/images/background.jpg")
    // ------------------------------------------------------------

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

    // ------------------------------------------------------------
    // 9. Everything else passes through unchanged
    // ------------------------------------------------------------

    return response;
  }
};
