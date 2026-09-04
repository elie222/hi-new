import { describe, expect, test } from "bun:test";
import { makeTestApp } from "./helpers";

describe("staging guard", () => {
  test("staging answers noindex everywhere and disallows crawling", async () => {
    const { app } = await makeTestApp();
    const robots = await app.request("http://staging.hi.test/robots.txt", {}, { STAGE: "staging" });
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain("Disallow: /");
    const page = await app.request("http://staging.hi.test/nobody-here-yet", {}, { STAGE: "staging" });
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("production is untouched", async () => {
    const { app } = await makeTestApp();
    const page = await app.request("http://hi.test/nobody-here-yet");
    expect(page.headers.get("x-robots-tag")).toBeNull();
    expect((await app.request("http://hi.test/robots.txt")).status).toBe(404);
  });

  test("unknown paths fall through to the assets binding", async () => {
    const { app } = await makeTestApp();
    const ASSETS = {
      fetch: async (req: Request) =>
        new URL(req.url).pathname === "/x.css"
          ? new Response("body{}", { headers: { "content-type": "text/css" } })
          : new Response("nope", { status: 404 }),
    };
    const hit = await app.request("http://hi.test/x.css", {}, { ASSETS });
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe("body{}");
    expect((await app.request("http://hi.test/y.css", {}, { ASSETS })).status).toBe(404);
  });
});
