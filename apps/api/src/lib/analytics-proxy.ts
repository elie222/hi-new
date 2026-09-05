export async function proxyAnalytics(
  request: Request,
  send: (request: Request) => Promise<Response> = fetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  const path = incoming.pathname.slice("/__h".length);
  const asset = path.startsWith("/static/") || path.startsWith("/array/");
  if (!asset && !["/e/", "/batch/", "/i/v0/e/", "/flags/"].includes(path)) {
    return new Response(null, { status: 404 });
  }
  const methods = asset ? ["GET", "HEAD"] : ["GET", "POST"];
  if (!methods.includes(request.method)) {
    return new Response(null, { status: 405, headers: { allow: methods.join(", ") } });
  }

  const upstream = new URL(asset ? "https://us-assets.i.posthog.com" : "https://us.i.posthog.com");
  upstream.pathname = path;
  upstream.search = incoming.search;
  const headers = new Headers();
  for (const name of ["content-type", "content-encoding", "accept", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);

  try {
    const response = await send(new Request(upstream, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : null,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }));
    if (response.status >= 300 && response.status < 400) {
      return new Response(null, { status: 502 });
    }
    const responseHeaders = new Headers();
    for (const name of ["content-type", "content-encoding", "cache-control", "etag", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (!asset) responseHeaders.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return new Response(null, { status: 502 });
  }
}
