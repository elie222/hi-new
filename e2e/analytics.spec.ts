import { expect, test } from "@playwright/test";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { ANALYTICS_BOOTSTRAP } from "../packages/ui/src/analytics";

test("analytics scrubs secrets, queues early events, and retains the browser identity", async ({ page }) => {
  // PostHog filters automated browsers.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
  });
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const requests: string[] = [];
  const directRequests: string[] = [];
  await page.route("https://*.posthog.com/**", (route) => {
    directRequests.push(route.request().url());
    return route.abort();
  });
  await page.route("https://hi.new/__h/**", async (route) => {
    requests.push(route.request().url());
    const body = route.request().postDataBuffer();
    if (body && new URL(route.request().url()).pathname.endsWith("/e/")) {
      const decoded = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
      const text = decoded.toString();
      const data = text.startsWith("data=") ? new URLSearchParams(text).get("data") : null;
      const payload = JSON.parse(data ? Buffer.from(data, "base64").toString() : text);
      events.push(...(payload.batch ?? (Array.isArray(payload) ? payload : [payload])));
    }
    await route.fulfill({ json: {} });
  });
  await page.route("https://hi.new/**", async (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/__h/")) return route.fallback();
    if (new URL(route.request().url()).pathname === "/site.js") {
      return route.fulfill({ path: resolve("apps/landing/dist/site.js"), contentType: "text/javascript" });
    }
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>
      <title>private-name private-message</title>
      <script>${ANALYTICS_BOOTSTRAP}</script>
      <script>window.hiTrack("claim_started",{source:"landing",paid:false})</script>
      <script defer src="/site.js"></script>
      </head><body><button>private-message</button><input value="private@example.com"></body></html>` });
  });
  await page.goto("https://hi.new/i/hni_secret?token=hn_secret#hns_secret", {
    referer: "https://hi.new/owner/l/magic-secret?email=private@example.com",
  });
  await expect.poll(() => events.some((event) => event.event === "claim_started")).toBe(true);
  await expect.poll(() => events.some((event) => event.event === "$pageview")).toBe(true);
  const first = events.find((event) => event.event === "$pageview")!;
  expect(first.properties.$current_url).toBe("https://hi.new/i/:token");
  expect(first.properties.$referrer).toBe("https://hi.new");
  expect(first.properties.distinct_id).toBeTruthy();
  expect(first.properties.$process_person_profile).toBe(false);

  await page.getByRole("button").click();
  await page.addScriptTag({ url: "https://hi.new/site.js" });
  await page.evaluate(() => window.hiTrack?.("invite_created", { source: "setup" }));
  await expect.poll(() => events.some((event) => event.event === "invite_created")).toBe(true);
  expect(events.filter((event) => event.event === "$pageview")).toHaveLength(1);
  expect(events.every((event) => ["$pageview", "claim_started", "invite_created"].includes(event.event))).toBe(true);

  await page.goto("https://hi.new/private-name/setup?step=live&token=hn_secret");
  await expect.poll(() => events.filter((event) => event.event === "$pageview").length).toBe(2);
  const second = events.filter((event) => event.event === "$pageview")[1]!;
  expect(second.properties.$current_url).toBe("https://hi.new/:name/setup");
  expect(second.properties.distinct_id).toBe(first.properties.distinct_id);
  const captured = JSON.stringify({ events, requests });
  expect(directRequests).toEqual([]);
  for (const secret of ["hn_secret", "hni_secret", "hns_secret", "magic-secret", "private-name", "private-message", "private@example.com"]) {
    expect(captured).not.toContain(secret);
  }
});

test("local and staging pages do not contact PostHog", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("posthog.com") || new URL(request.url()).pathname.startsWith("/__h/")) requests.push(request.url());
  });
  await page.route("https://*.posthog.com/**", (route) => route.fulfill({ json: {} }));
  await page.goto("/");
  expect(await page.locator('script[src="/site.js"]').count()).toBe(1);
  expect(await page.evaluate(() => window.hiAnalyticsLoaded)).toBeUndefined();

  await page.route("https://staging.hi.new/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Staging</title>" }));
  await page.goto("https://staging.hi.new/");
  await page.addScriptTag({ content: ANALYTICS_BOOTSTRAP });
  await page.addScriptTag({ path: resolve("apps/landing/dist/site.js") });
  expect(await page.evaluate(() => window.hiAnalyticsLoaded)).toBeUndefined();
  expect(requests).toEqual([]);
});
