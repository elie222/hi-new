import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { proxyAnalytics } from "../src/lib/analytics-proxy";

test("forwards event bytes and trusted IP without application credentials", async () => {
  const payload = new Uint8Array([31, 139, 8, 0, 255]);
  const response = await proxyAnalytics(new Request("https://hi.new/r/e/?compression=gzip-js", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      cookie: "owner_session=secret",
      authorization: "Bearer secret",
      "x-hi-new-claim-token": "secret",
      referer: "https://hi.new/i/private-token",
      "cf-connecting-ip": "203.0.113.10",
      "x-forwarded-for": "spoofed",
    },
    body: payload,
  }), async (upstream) => {
    expect(upstream.url).toBe("https://us.i.posthog.com/e/?compression=gzip-js");
    expect(upstream.method).toBe("POST");
    expect(new Uint8Array(await upstream.arrayBuffer())).toEqual(payload);
    expect(upstream.headers.get("x-forwarded-for")).toBe("203.0.113.10");
    for (const name of ["cookie", "authorization", "x-hi-new-claim-token", "referer"]) {
      expect(upstream.headers.has(name)).toBe(false);
    }
    expect(upstream.redirect).toBe("manual");
    return new Response("ok", { headers: { "set-cookie": "unexpected=secret", "cache-control": "public" } });
  });
  expect(await response.text()).toBe("ok");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("routes SDK assets and configuration to the asset host", async () => {
  for (const path of ["/static/array.js", "/array/test-project/config"]) {
    const response = await proxyAnalytics(new Request("https://hi.new/r" + path), async (upstream) => {
      expect(upstream.url).toBe("https://us-assets.i.posthog.com" + path);
      return new Response("asset", { headers: { "cache-control": "public, max-age=300" } });
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  }
});

test("rejects unsupported paths and methods before database middleware", async () => {
  const app = createApp();
  expect((await app.request("https://hi.new/r/private")).status).toBe(404);
  expect((await app.request("https://hi.new/r/e/", { method: "DELETE" })).status).toBe(405);
  expect((await app.request("https://hi.new/r/static/array.js", { method: "POST" })).status).toBe(405);
});

test("preserves ingestion errors but contains upstream failures and redirects", async () => {
  const request = new Request("https://hi.new/r/e/");
  const rejected = await proxyAnalytics(request, async () => new Response("rate limited", { status: 429 }));
  expect(rejected.status).toBe(429);
  expect(await rejected.text()).toBe("rate limited");
  const failed = await proxyAnalytics(request, async () => { throw new Error("unavailable"); });
  expect(failed.status).toBe(502);
  const redirected = await proxyAnalytics(request, async () => Response.redirect("https://other.example", 302));
  expect(redirected.status).toBe(502);
  expect(redirected.headers.has("location")).toBe(false);
});
