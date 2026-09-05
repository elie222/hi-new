import { expect, test } from "@playwright/test";
import { captureScreenshot, expectNoHorizontalOverflow, unique, uniquePaidName } from "./helpers";

test("setup shell keeps the footer down before React loads", async ({ page }) => {
  await page.route("**/_astro/SetupFlow.*.js", (route) => route.abort());
  await page.goto("/setup");

  const shell = await page.locator(".setup-page-shell").boundingBox();
  const footer = await page.locator("footer").boundingBox();
  const viewport = page.viewportSize();

  expect(shell).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(shell!.height).toBeGreaterThan(0);
  expect(Math.round(footer!.y + footer!.height)).toBeGreaterThanOrEqual(viewport!.height - 1);
});

// URL-driven steps make browser Back walk the setup flow.
test("react setup flow: ceremony, handoff, email step, live finale", async ({ page, request }, testInfo) => {
  const name = unique("e2e-rsetup");
  const claim = await request.post("/api/handles", { data: { name } });
  expect(claim.status()).toBe(201);
  const { token } = await claim.json();

  await page.goto("/");
  await page.evaluate(
    (saved) => sessionStorage.setItem("hi_claim", JSON.stringify(saved)),
    { name, token },
  );
  await page.goto(`/${name}/setup`);

  await expect(page.getByText(`hi.new/${name}`).first()).toBeVisible();
  await expect(page.locator(".panel")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(page.getByRole("link", { name: "Post it on X" })).toHaveAttribute("href", /x\.com\/intent\/post/);
  await captureScreenshot(page, testInfo, "30-setup-its-yours");
  await page.getByRole("button", { name: "Set up your bot" }).click();

  const prompt = page.locator("#bot-prompt");
  await expect(prompt).toContainText("Setup code: hns_");
  await expect(prompt).not.toContainText("hn_6");
  await captureScreenshot(page, testInfo, "31-setup-paste");
  await page.locator("#copy-prompt").click();
  await expect(page.locator("#open-grokbot")).toHaveCount(testInfo.project.name === "mobile" ? 0 : 1);
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page).toHaveURL(/step=email/);
  await expect(page.getByText("lose this name")).toBeVisible();
  await captureScreenshot(page, testInfo, "32-setup-email");
  await page.getByPlaceholder("you@example.com").fill(`${name}@example.com`);
  await page.getByRole("button", { name: "Send link" }).click();

  await expect(page).toHaveURL(/step=live/);
  await expect(page.getByRole("heading", { name: "Your bot is live." })).toBeVisible();
  await expect(page.locator("#panel-email")).toHaveCount(0);
  await expect(page.locator("#panel-invite")).toContainText("Send a friend an invite:");
  await expect(page.locator("#setup-nudge")).toContainText("hasn’t checked in yet");
  await captureScreenshot(page, testInfo, "33-setup-live");
  await page.getByRole("button", { name: /find us a time to meet/ }).click();
  await expect(page.locator("#invite-text")).toContainText("/i/hni_");
  await expect(page.locator("#invite-text")).toContainText("find us a time to meet");
  await captureScreenshot(page, testInfo, "33b-setup-invite");
  await page.getByRole("button", { name: "Show the setup prompt." }).click();
  await expect(page.locator("#panel-bot")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/step=live/);

  await page.goBack();
  await expect(page.getByText("lose this name")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#panel-bot")).toBeVisible();
  await captureScreenshot(page, testInfo, "34-setup-back");
  await page.goBack();
  await expect(page.getByRole("button", { name: "Set up your bot" })).toBeVisible();
  await expect(page.locator(".swatch").first()).toBeVisible();

  await page.goto(`/${name}/setup`);
  await expect(page.locator("#panel-bot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up your bot" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "35-setup-resume");

  await page.goto(`/${name}`);
  await expect(page.getByRole("link", { name: "Set up your bot" })).toBeVisible();
  await captureScreenshot(page, testInfo, "36-own-profile-cta");
});

test("react setup flow: bare /setup canonicalizes, skip email, Back walks the steps", async ({ page, request }) => {
  const name = unique("e2e-rurl");
  const claim = await request.post("/api/handles", { data: { name } });
  expect(claim.status()).toBe(201);
  const { token } = await claim.json();

  await page.goto("/");
  await page.evaluate(
    (saved) => sessionStorage.setItem("hi_claim", JSON.stringify(saved)),
    { name, token },
  );
  await page.goto("/setup");
  await expect(page).toHaveURL(new RegExp(`/${name}/setup`));
  await page.getByRole("button", { name: "Set up your bot" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/step=email/);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/step=live/);
  await expect(page.getByRole("button", { name: /say hi to yours/ })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/step=email/);
});

test("paid setup recognizes an activated claim after sign-in returns", async ({ page, request }) => {
  const name = uniquePaidName();
  const claim = await request.post("/api/handles", { data: { name } });
  expect(claim.status()).toBe(402);
  const body = await claim.json();

  await page.goto("/");
  await page.evaluate(
    (saved) => sessionStorage.setItem("hi_claim", JSON.stringify(saved)),
    { name, token: body.token, paid: true, price_usd_per_year: body.price_usd_per_year, checkout_url: body.checkout_url },
  );
  await page.route("**/api/handles/me", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name, color: "blue", email: null, email_verified: false }),
    });
  });

  await page.goto(`/${name}/setup?step=email`);
  await expect(page.getByText("lose this name")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Almost yours." })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("hi_claim")!).paid)).toBeUndefined();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("hi_claim")!).checkout_url)).toBeUndefined();
});

test("paid setup does not expose raw checkout errors", async ({ page, request }) => {
  const name = uniquePaidName();
  const claim = await request.post("/api/handles", { data: { name } });
  expect(claim.status()).toBe(402);
  const body = await claim.json();

  await page.goto("/");
  await page.evaluate(
    (saved) => sessionStorage.setItem("hi_claim", JSON.stringify(saved)),
    { name, token: body.token, paid: true, price_usd_per_year: body.price_usd_per_year, checkout_url: body.checkout_url },
  );
  await page.route(`**/buy/${name}/checkout`, (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "name_taken" }) }),
  );

  await page.goto(`/${name}/setup`);
  await page.getByRole("button", { name: /Pay \$/ }).click();
  await expect(page.getByText(`hi.new/${name} is already active.`)).toBeVisible();
  await expect(page.getByText("name_taken", { exact: true })).toHaveCount(0);
});
