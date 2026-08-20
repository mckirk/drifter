const JSON_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Content-Type": "application/json; charset=utf-8",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function allowedOrigin(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const configured = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.includes("*")) return "*";
  if (!requestOrigin) return null;
  return configured.includes(requestOrigin) ? requestOrigin : false;
}

function responseHeaders(origin) {
  const headers = new Headers(JSON_HEADERS);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (origin === false) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    if (request.method === "OPTIONS") {
      const headers = responseHeaders(origin);
      headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname !== "/time" || request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: responseHeaders(origin),
      });
    }

    // Workers freezes Date.now() between I/O operations. For this CPU-only
    // response the receive and send timestamps intentionally match.
    const serverReceiveTime = Date.now();
    const serverSendTime = Date.now();

    return new Response(
      JSON.stringify({
        serverReceiveTime,
        serverSendTime,
        precision: 1,
      }),
      { headers: responseHeaders(origin) },
    );
  },
};
