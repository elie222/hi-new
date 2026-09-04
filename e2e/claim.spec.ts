import { expect, test } from "@playwright/test";
import { captureScreenshot, expectNoHorizontalOverflow, latestMailTo, linkIn, unique } from "./helpers";

test("a free-name limit is not reported as a taken name", async ({ page }) => {
  const name = unique("available-name");
  await page.route("**/api/handles", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "email_name_limit", limit: 25 }),
    });
  });

  await page.goto("/");
  await page.getByPlaceholder("yourname").fill(name);
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText("This email already has 25 free names.")).toBeVisible();
  await expect(page.getByText(/is taken/)).toHaveCount(0);

  await page.goto(`/${name}`);
  await page.getByRole("button", { name: "Claim it free" }).click();
  await expect(page.getByText("This email already has 25 free names.")).toBeVisible();
  await expect(page.getByText("Someone just took it.")).toHaveCount(0);
});

test("claim a name on the landing, hand a setup code to a bot, verify the email", async ({ page, request }, testInfo) => {
  const name = unique("e2e-claim");
  const email = `${name}@example.com`;

  await page.goto("/");
  await page.getByPlaceholder("yourname").fill(name);
  await captureScreenshot(page, testInfo, "10-claim-name-entered");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${name}/setup`));
  await expect(page.getByText(`hi.new/${name}`).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "11-setup-its-yours");
  await page.getByRole("button", { name: "Set up your bot" }).click();

  const prompt = page.locator("#bot-prompt");
  await expect(prompt).toContainText("Setup code: hns_");
  await expect(prompt).not.toContainText("hn_6");
  const code = (await prompt.textContent())!.match(/hns_[\w-]+/)![0];

  const swap = await request.post("/api/setup", { data: { code } });
  expect(swap.status()).toBe(200);
  const { token } = await swap.json();
  expect(token).toMatch(/^hn_/);
  expect((await request.post("/api/setup", { data: { code } })).status()).toBe(410);

  await page.getByRole("button", { name: "Next" }).click();
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page).toHaveURL(/step=live/);
  await expect(page.locator("#panel-email")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "12-setup-email-sent");
  const verify = await latestMailTo(request, email, `Verify hi.new/${name}`);
  const verified = await page.goto(linkIn(verify.text, "/v/"));
  expect(verified?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: `hi.new/${name} is verified` })).toBeVisible();
  await captureScreenshot(page, testInfo, "13-email-verified");
  const me = await request.get("/api/handles/me", { headers: { authorization: `Bearer ${token}` } });
  expect((await me.json()).email_verified).toBe(true);

  await page.goto(`/${name}/setup?step=live`);
  await expect(page.locator("#panel-email")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "14-setup-verified");
});

test("claiming while signed in attaches the owner email", async ({ page, request }, testInfo) => {
  const owner = unique("e2e-owner");
  const email = `${owner}@example.com`;
  const first = await request.post("/api/handles", { data: { name: owner, email } });
  expect(first.status()).toBe(201);
  const verify = await latestMailTo(request, email, `Verify hi.new/${owner}`);
  await request.get(linkIn(verify.text, "/v/"));
  await page.goto("/owner");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  const m = await latestMailTo(request, email, "Sign in");
  await page.goto(linkIn(m.text, "/owner/l/"));
  await page.getByRole("link", { name: "Continue to dashboard" }).click();

  const second = unique("e2e-second");
  await page.getByRole("link", { name: "hi.new home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("[data-owner-link]")).toHaveText("Dashboard");
  await page.getByPlaceholder("yourname").fill(second);
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${second}/setup`));
  await page.getByRole("button", { name: "Set up your bot" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("#panel-email")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "18-setup-signed-in-owner");

  await page.goto(`/${second}`);
  await expect(page.getByText(`hi.new/${second}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/Ask its owner for an invite link/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Set up your bot" })).toBeVisible();
  await captureScreenshot(page, testInfo, "19-owned-bot-profile");
});
