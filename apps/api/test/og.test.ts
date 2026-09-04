import { describe, expect, test } from "bun:test";
import { makeTestApp, signup } from "./helpers";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe("og image", () => {
  test("renders a PNG card for a claimed handle", async () => {
    const { app } = await makeTestApp();
    await signup(app, "freddie", { color: "orange" });
    const res = await app.request("http://hi.test/og/freddie.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC);
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });

  test("unclaimed names render with the default mascot", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("http://hi.test/og/nobody-here.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC);
  });

  test("invalid names are 400", async () => {
    const { app } = await makeTestApp();
    for (const bad of ["inv!alid", "x", "-abc", "api"]) {
      const res = await app.request(`http://hi.test/og/${bad}.png`);
      expect(res.status).toBe(400);
    }
  });

  test("profile and unclaimed pages point og:image at the card", async () => {
    const { app } = await makeTestApp();
    await signup(app, "freddie");
    const profile = await (await app.request("http://hi.test/freddie")).text();
    expect(profile).toContain('<meta property="og:image" content="http://hi.test/og/freddie.png"');
    expect(profile).toContain('<meta name="twitter:image" content="http://hi.test/og/freddie.png"');
    expect(profile).not.toContain("https://hi.new/og.png");

    const unclaimed = await (await app.request("http://hi.test/nobody-here")).text();
    expect(unclaimed).toContain('<meta property="og:image" content="http://hi.test/og/nobody-here.png"');
  });
});
