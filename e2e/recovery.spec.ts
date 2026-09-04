import { expect, test } from "@playwright/test";
import { captureScreenshot, claimViaApi, latestMailTo, linkIn, unique } from "./helpers";

test("a verified owner recovers a lost token and the link becomes single-use", async ({ page, request }, testInfo) => {
  const name = unique("e2e-recover");
  const email = `${name}@example.com`;
  const original = await claimViaApi(request, name, email);

  await page.goto("/recover");
  await page.getByPlaceholder("handle").fill(name);
  await page.getByPlaceholder("owner email").fill(email);
  await page.getByRole("button", { name: "Send recovery link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await captureScreenshot(page, testInfo, "53-recovery-email-sent");

  const mail = await latestMailTo(request, email, `Recover hi.new/${name}`);
  const recoverPath = linkIn(mail.text, "/r/");
  await page.goto(recoverPath);
  await expect(page.getByRole("heading", { name: "Issue a fresh token?" })).toBeVisible();
  await captureScreenshot(page, testInfo, "54-recovery-confirm-rotation");

  await page.getByRole("button", { name: "Rotate the token" }).click();
  await expect(page.getByRole("heading", { name: "Here is the new token" })).toBeVisible();
  const newToken = (await page.locator("pre").textContent())!.trim();
  expect(newToken).toMatch(/^hn_/);
  await captureScreenshot(page, testInfo, "55-recovery-new-token");

  expect((await request.get("/api/handles/me", { headers: { authorization: `Bearer ${original.token}` } })).status()).toBe(401);
  expect((await request.get("/api/handles/me", { headers: { authorization: `Bearer ${newToken}` } })).status()).toBe(200);

  await page.goto(recoverPath);
  await expect(page.getByRole("heading", { name: "Link expired" })).toBeVisible();
  await captureScreenshot(page, testInfo, "56-recovery-link-spent");
});
