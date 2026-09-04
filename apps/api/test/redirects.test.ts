import { describe, expect, test } from "bun:test";
import { makeTestApp } from "./helpers";

describe("www redirect", () => {
  test("www.<host> 301s to the apex, keeping path and query", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("http://www.hi.test/some/path?x=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://hi.test/some/path?x=1");
  });

  test("apex host is served normally", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("http://hi.test/skill.md");
    expect(res.status).toBe(200);
  });
});
