import { expect, test } from "@playwright/test";
import { captureScreenshot, expectNoHorizontalOverflow, unique, uniquePaidName } from "./helpers";

test("landing, connect and public pages render", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "hi.new home" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "01-landing-page");
  await page.goto("/connect");
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "02-connect-guide");
  await page.goto("/nobody-here-yet");
  await expect(page.getByText("hi.new/", { exact: false }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "03-unclaimed-free-profile");

  await page.goto("/owner");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await captureScreenshot(page, testInfo, "04-owner-sign-in");

  await page.goto("/recover");
  await expect(page.getByRole("heading", { name: "Recover a token" })).toBeVisible();
  await captureScreenshot(page, testInfo, "05-recover-token-form");
});

test("paid name reservation renders checkout and the saved setup state", async ({ page, request }, testInfo) => {
  const name = uniquePaidName();
  const claim = await request.post("/api/handles", { data: { name } });
  expect(claim.status()).toBe(402);
  const body = await claim.json();

  await page.goto(`/${name}`);
  await expect(page.getByRole("button", { name: /Claim it/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "06-unclaimed-paid-profile");

  await page.goto(`/buy/${name}`);
  await expect(page.getByRole("button", { name: /Pay \$50 \/ year/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "07-paid-name-checkout");

  await page.goto("/");
  await page.evaluate((saved) => sessionStorage.setItem("hi_claim", JSON.stringify(saved)), {
    name,
    token: body.token,
    paid: true,
    price_usd_per_year: body.price_usd_per_year,
    checkout_url: body.checkout_url,
  });
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Almost yours." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay $50/yr" })).toBeVisible();
  await captureScreenshot(page, testInfo, "08-paid-name-reserved-setup");
});

test("an encrypted public profile shows its key fingerprint", async ({ page, request }, testInfo) => {
  const name = unique("e2e-encrypted");
  const claim = await request.post("/api/handles", {
    data: { name, public_key: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxxxxx" },
  });
  expect(claim.status()).toBe(201);

  await page.goto(`/${name}`);
  await expect(page.getByText(`hi.new/${name}`, { exact: true })).toBeVisible();
  await expect(page.getByText("key fingerprint")).toHaveCount(0);
  const api = await (await request.get(`/api/handles/${name}`)).json();
  expect(api.e2e).toBe(true);
  expect(api.fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  await captureScreenshot(page, testInfo, "09-encrypted-public-profile");
});
