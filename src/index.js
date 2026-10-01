export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const UPSTREAM = (env.UPSTREAM_URL || "").replace(/\/+$/, "");
    const BASE = normalizeBasePath(env.BASE_PATH || "/");

    if (!UPSTREAM) {
      return new Response("UPSTREAM_URL is not configured.", {
        status: 500
      });
    }

    let path = url.pathname;

    // /rice/                  -> /
    // /rice/images/photo.jpg  -> /images/photo.jpg
    if (BASE !== "/") {
      if (path === BASE || path === `${BASE}/`) {
        path = "/";
      } else if (path.startsWith(`${BASE}/`)) {
        path = path.slice(BASE.length) || "/";
      }
    }

    const upstreamUrl = `${UPSTREAM}${path}${url.search}`;

    const response = await fetch(
      new Request(upstreamUrl, request)
    );

    const contentType =
      response.headers.get("content-type") || "";

    // Rewrite root-relative URLs in HTML
    if (BASE !== "/" && contentType.includes("text/html")) {
      return new HTMLRewriter()
        .on("[src]", {
          element(el) {
            rewriteAttribute(el, "src", BASE);
          }
        })
        .on("[href]", {
          element(el) {
            rewriteAttribute(el, "href", BASE);
          }
        })
        .transform(response);
    }

    // Rewrite root-relative URLs inside JavaScript
    if (BASE !== "/" && isJavaScript(contentType)) {
      return rewriteTextResponse(response, body =>
        rewriteRootRelativeUrls(body, BASE)
      );
    }

    // Rewrite root-relative URLs inside CSS
    if (BASE !== "/" && contentType.includes("text/css")) {
      return rewriteTextResponse(response, body =>
        rewriteCssUrls(body, BASE)
      );
    }

    return response;
  }
};

function normalizeBasePath(value) {
  let base = value.trim();

  if (!base || base === "/") {
    return "/";
  }

  if (!base.startsWith("/")) {
    base = `/${base}`;
  }

  return base.replace(/\/+$/, "");
}

function isJavaScript(contentType) {
  return (
    contentType.includes("javascript") ||
    contentType.includes("ecmascript")
  );
}

function rewriteAttribute(element, attribute, base) {
  const value = element.getAttribute(attribute);

  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith(`${base}/`) &&
    value !== base
  ) {
    element.setAttribute(attribute, `${base}${value}`);
  }
}

async function rewriteTextResponse(response, transform) {
  const body = await response.text();
  const headers = new Headers(response.headers);

  // Body has been decoded, so these are no longer valid.
  headers.delete("content-encoding");
  headers.delete("content-length");

  return new Response(transform(body), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function rewriteRootRelativeUrls(body, base) {
  const escapedBase = escapeRegExp(base);

  const regex = new RegExp(
    `(["'\`])\\/(?!\\/|${escapedBase.replace(/^\\\//, "")}\\/)([^"'\\\`?#]+)([?#]?[^"'\\\`]*)\\1`,
    "g"
  );

  return body.replace(
    regex,
    `$1${base}/$2$3$1`
  );
}

function rewriteCssUrls(body, base) {
  const escapedBase = escapeRegExp(base);

  const regex = new RegExp(
    `url\\(\\s*(['"]?)\\/(?!\\/|${escapedBase.replace(/^\\\//, "")}\\/)([^)'"]+)\\1\\s*\\)`,
    "g"
  );

  return body.replace(
    regex,
    `url($1${base}/$2$1)`
  );
}

function escapeRegExp(value) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}
