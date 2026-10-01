// worker/index.ts
//
// Cloudflare Worker entrypoint that sits in front of static assets
// AND TanStack Start's server handler.
//
// Order of routing (important):
//   1. /api/*         → handled inline below (returns JSON)
//   2. everything else → handed to TanStack Start (SSR, /_serverFn, etc.)
//   3. unmatched      → static assets + SPA fallback (index.html)
//
// Requires: @tanstack/react-start >= 1.0 (provides `server-entry`).
// Requires: wrangler >= 4.20 with `assets.run_worker_first` array support.

import startHandler from "@tanstack/react-start/server-entry";

// ---------------------------------------------------------------------------
// Environment bindings
// Extend this interface as you add KV, D1, R2, Queues, etc.
// ---------------------------------------------------------------------------
interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // 1. Custom API routes — MUST come before the SPA fallback.
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, ctx);
    }

    // 2. Everything else: TanStack Start's server handler.
    //
    //    `startHandler` is the fetch handler exported by TanStack Start.
    //    It handles:
    //      • SSR of your route tree
    //      • Server functions at   /verification/_serverFn/<id>
    //      • Route matching, loaders, beforeLoad, etc.
    //    It will NOT serve raw index.html for unknown paths — that job is
    //    delegated to the ASSETS binding via `not_found_handling`.
    return startHandler.fetch(request, env, ctx);
  },
};

// ---------------------------------------------------------------------------
// Custom API handler
// ---------------------------------------------------------------------------
async function handleApiRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // --- Example: GET /api/health -------------------------------------------
  if (url.pathname === "/api/health" && method === "GET") {
    return json({ status: "ok", timestamp: new Date().toISOString() });
  }

  // --- Example: GET /api/verify?hash=<hash> --------------------------------
  // Replace this stub with your real verification logic (lookup, HMAC, etc.).
  if (url.pathname === "/api/verify" && method === "GET") {
    const hash = url.searchParams.get("hash");
    if (!hash) {
      return json({ error: "Missing `hash` query parameter" }, 400);
    }
    return json({
      hash,
      status: "verified",
      verifiedAt: new Date().toISOString(),
    });
  }

  // --- Example: POST /api/echo --------------------------------------------
  if (url.pathname === "/api/echo" && method === "POST") {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    return json({ received: body });
  }

  // --- Example: proxy to an external backend ------------------------------
  // if (url.pathname.startsWith("/api/proxy/")) {
  //   const upstream = new URL(request.url);
  //   upstream.hostname = "api.your-backend.com";
  //   upstream.pathname = url.pathname.replace(/^\/api\/proxy/, "");
  //   return fetch(upstream.toString(), {
  //     method,
  //     headers: request.headers,
  //     body: method === "GET" || method === "HEAD" ? undefined : request.body,
  //   });
  // }

  // --- Fallback: 404 JSON (never HTML) ------------------------------------
  return json(
    { error: "API route not found", path: url.pathname, method },
    404
  );
}

// ---------------------------------------------------------------------------
// Tiny JSON helper
// ---------------------------------------------------------------------------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
