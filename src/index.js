/**
 * Generic subpath router/proxy for Cloudflare Workers.
 *
 * This single Worker can serve any number of OTHER, separately-deployed
 * Workers under path prefixes of one domain — for example:
 *
 *   example.com/test  -> served by one Worker
 *   example.com/blog  -> served by a different Worker
 *
 * All of it is controlled by ONE variable, ROUTES_JSON (see README.md).
 * Nobody needs to touch this file again after it's first deployed.
 * New paths are added by editing ROUTES_JSON in the Cloudflare dashboard.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Read the route list from the ROUTES_JSON variable.
    let routes;
    try {
      routes = JSON.parse(env.ROUTES_JSON || "{}");
    } catch (err) {
      return new Response(
        "ROUTES_JSON is not valid JSON. Check Settings > Variables and Secrets in the Cloudflare dashboard.",
        { status: 500 }
      );
    }

    // 2. Find which path prefix this request matches.
    //    Longest match wins, so "/blog/archive" can't accidentally
    //    match a shorter, unrelated "/b" entry.
    const BASE = Object.keys(routes)
      .filter((p) => url.pathname === p || url.pathname.startsWith(p + "/"))
      .sort((a, b) => b.length - a.length)[0];

    if (!BASE) {
      return new Response("Not found", { status: 404 });
    }

    const UPSTREAM = routes[BASE].replace(/\/$/, "");

    // 3. Strip the prefix before asking the upstream Worker for the page.
    //    /test             -> /
    //    /test/             -> /
    //    /test/images/x.jpg -> /images/x.jpg
    let path = url.pathname;
    path = path === BASE || path === BASE + "/" ? "/" : path.slice(BASE.length);

    const targetUrl = UPSTREAM + path + url.search;
    const response = await fetch(new Request(targetUrl, request));
    const contentType = response.headers.get("content-type") || "";

    // 4. The upstream site doesn't know it's being served from a subpath,
    //    so its HTML/JS refers to assets at the domain root (e.g. "/assets/x.js").
    //    We rewrite those references to include the prefix, so the browser
    //    asks for "/test/assets/x.js" instead.

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

    if (contentType.includes("text/html")) {
      return new HTMLRewriter()
        .on("[src]", attrRewriter("src"))
        .on("[href]", attrRewriter("href"))
        .transform(response);
    }

    if (contentType.includes("javascript")) {
      let body = await response.text();

      const baseNoSlash = BASE.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const jsRewrite = new RegExp(
        `(["'\`])\\/(?!\\/|${baseNoSlash}\\/)([^"'\`?#]+)([?#]?[^"'\`]*)\\1`,
        "g"
      );
      body = body.replace(jsRewrite, `$1${BASE}/$2$3$1`);

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    // Images, CSS, fonts, etc. need no rewriting — pass through as-is.
    return response;
  }
};
