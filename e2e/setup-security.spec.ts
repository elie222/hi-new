import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";

test("blocked storage prevents a remote claim", async ({ page }) => {
  await signIn(page, `${unique("storage-owner")}@example.com`);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  let claims = 0;
  await page.route("**/api/owner/claims", (route) => { claims++; return route.abort(); });
  await page.goto("/");
  await page.getByPlaceholder("yourname").fill(unique("storage"));
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText("Enable browser storage before claiming a name.")).toBeVisible();
  expect(claims).toBe(0);
});

test("claim persistence failure preserves the token and displays recovery", async ({ page }) => {
  const name = unique("storage-recovery");
  await signIn(page, `${unique("storage-owner")}@example.com`);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === "hi_claim" && ++writes > 1) throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.goto("/");
  await page.getByPlaceholder("yourname").fill(name);
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText(/Claim succeeded. Save this token before leaving:/)).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("hi_claim")!));
  await expect(page.locator("#claim-status")).toContainText(saved.token);
  const me = await page.request.get("/api/handles/me", { headers: { authorization: `Bearer ${saved.token}` } });
  expect(me.status()).toBe(200);
});

test("setup copy waits for its single in-flight mint request", async ({ page, request }) => {
  const name = unique("code-race");
  const claim = await request.post("/api/handles", { data: { name } });
  const { token } = await claim.json();
  await page.goto("/");
  await page.evaluate((saved) => sessionStorage.setItem("hi_claim", JSON.stringify(saved)), { name, token });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/handles/me/setup-code", async (route) => {
    requests++;
    await pending;
    await route.continue();
  });
  await page.goto(`/${name}/setup?step=paste`);
  const copy = page.locator("#copy-prompt");
  await expect(copy).toBeDisabled();
  expect(requests).toBe(1);
  release();
  await expect(copy).toBeEnabled();
  await expect(page.locator("#bot-prompt")).toContainText("Setup code: hns_");
  await copy.click();
  expect(requests).toBe(1);
});

test("a payment query flag cannot confirm ownership without credentials", async ({ page, request }) => {
  const name = unique("not-your-name");
  expect((await request.post("/api/handles", { data: { name } })).status()).toBe(201);
  await page.goto(`/${name}/setup?paid=1`);
  await expect(page).toHaveURL(new RegExp(`/${name}$`));
  await expect(page.getByRole("heading", { name: "It’s yours." })).toHaveCount(0);
  await expect(page.getByText("Payment received.")).toHaveCount(0);
});
