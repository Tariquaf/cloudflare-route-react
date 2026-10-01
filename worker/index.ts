// worker/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Intercept API routes FIRST
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    // Everything else falls through to static assets (SPA fallback)
    return env.ASSETS.fetch(request);
  },
};

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  // Option A: Proxy to an external backend
  // const apiUrl = new URL(request.url);
  // apiUrl.hostname = 'your-backend.example.com';
  // return fetch(apiUrl.toString(), {
  //   method: request.method,
  //   headers: request.headers,
  // });

  // Option B: Handle inline (example health check)
  return new Response(JSON.stringify({ status: 'ok' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
