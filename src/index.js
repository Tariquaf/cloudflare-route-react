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
    // 3. Optional default upstream
    //
    // This is useful when a site is being tested on a dedicated
    // subdomain such as:
    //
    // rice.example.com/*
    //
    // and the SPA asks for:
    //
    // /images/...
    // /brand/...
    // /api/...
    //
    // Set DEFAULT_UPSTREAM only when appropriate.
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
    // ------------------------------------------------------------

    let path = url.pathname;

    if (BASE) {
      path =
        path === BASE || path === BASE + "/"
          ? "/"
          : path.slice(BASE.length);
    }

    const targetUrl = UPSTREAM + path + url.search;

    // ------------------------------------------------------------
    // 5. Forward request
    // ------------------------------------------------------------

    const upstreamRequest = new Request(targetUrl, request);

    let response = await fetch(upstreamRequest);

    const contentType =
      response.headers.get("content-type") || "";

    // ------------------------------------------------------------
    // 6. Rewrite HTML
    // ------------------------------------------------------------

    if (BASE && contentType.includes("text/html")) {
      const attrRewriter = (attr) => ({
        element(el) {
          const value = el.getAttribute(attr);

          if (
            value &&
            value.startsWith("/") &&
            !value.startsWith("//") &&
            !value.startsWith(BASE + "/")
          ) {
            el.setAttribute(attr, BASE + value);
          }
        }
      });

      return new HTMLRewriter()
        .on("[src]", attrRewriter("src"))
        .on("[href]", attrRewriter("href"))
        .transform(response);
    }

    // ------------------------------------------------------------
    // 7. Rewrite JavaScript
    //
    // React/Vite builds often contain:
    //
    // "/images/x.jpg"
    // "/brand/logo.svg"
    // "/api/products"
    //
    // Convert these to:
    //
    // "/test/images/x.jpg"
    // "/test/brand/logo.svg"
    // "/test/api/products"
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
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const jsRewrite = new RegExp(
        `(["'\`])\\/(?!\\/|${baseNoSlash}\\/)([^"'\`?#]+)([?#]?[^"'\`]*)\\1`,
        "g"
      );

      body = body.replace(
        jsRewrite,
        `$1${BASE}/$2$3$1`
      );

      const headers = new Headers(response.headers);

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
    // ------------------------------------------------------------

    if (
      BASE &&
      contentType.includes("text/css")
    ) {
      let body = await response.text();

      const cssRewrite = new RegExp(
        `url\\(\\s*(["']?)\\/(?!\\/|${BASE.slice(1)}\\/)([^)"']+)\\1\\s*\\)`,
        "g"
      );

      body = body.replace(
        cssRewrite,
        `url($1${BASE}/$2$1)`
      );

      const headers = new Headers(response.headers);

      headers.delete("content-length");
      headers.delete("content-encoding");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // ------------------------------------------------------------
    // 9. Pass everything else through
    // ------------------------------------------------------------

    return response;
  }
};