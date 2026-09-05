import { expect, test } from "@playwright/test";
import { captureScreenshot, expectNoHorizontalOverflow, latestMailTo, linkIn, unique, uniquePaidName } from "./helpers";

test("sign in from a different browser before claiming and setting up a name", async ({ page: xBrowser, browser, request }, testInfo) => {
  const name = unique("e2e-claim");
  const email = `${name}@example.com`;
  await xBrowser.goto("/");
  await xBrowser.getByPlaceholder("yourname").fill(name);
  await xBrowser.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(xBrowser.getByRole("heading", { name: "Sign in to claim your name" })).toBeVisible();
  expect((await request.get(`/api/handles/${name}`)).status()).toBe(404);
  expect(await xBrowser.evaluate(() => sessionStorage.getItem("hi_claim"))).toBeNull();
  await xBrowser.getByPlaceholder("you@example.com").fill(email);
  await xBrowser.getByRole("button", { name: "Email me a sign-in link" }).click();
  const mail = await latestMailTo(request, email, "Sign in");
  expect((await request.get(`/api/handles/${name}`)).status()).toBe(404);

  const mainBrowser = await browser.newContext();
  try {
    const page = await mainBrowser.newPage();
    await page.goto(linkIn(mail.text, "/owner/l/"));
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}/setup`));
    await expect(page.getByText(`hi.new/${name}`).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await captureScreenshot(page, testInfo, "11-setup-its-yours");
    await page.getByRole("button", { name: "Set up your bot" }).click();
    const prompt = page.locator("#bot-prompt");
    await expect(prompt).toContainText("Setup code: hns_");
    const code = (await prompt.textContent())!.match(/hns_[\w-]+/)![0];
    const swap = await request.post("/api/setup", { data: { code } });
    expect(swap.status()).toBe(200);
    const { token } = await swap.json();
    expect((await request.post("/api/setup", { data: { code } })).status()).toBe(410);
    const me = await request.get("/api/handles/me", { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ email, email_verified: true });
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("#panel-email")).toHaveCount(0);

    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`/?claim=${name}`);
    await expect(page).toHaveURL(/\/owner$/);
    await expect(page.getByRole("link", { name: `hi.new/${name}`, exact: true })).toBeVisible();
  } finally {
    await mainBrowser.close();
  }
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


test("a paid profile claim signs in before reserving and starting checkout", async ({ page, request }) => {
  const name = uniquePaidName();
  const email = `${unique("paid-owner")}@example.com`;
  await page.route(`**/buy/${name}/checkout`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ hint: "Checkout test" }) }));
  await page.goto(`/${name}`);
  await page.getByRole("button", { name: /Claim it for/ }).click();
  await expect(page.getByRole("heading", { name: "Sign in to claim your name" })).toBeVisible();
  expect((await request.get(`/api/handles/${name}`)).status()).toBe(404);
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  const mail = await latestMailTo(request, email, "Sign in");
  await page.goto(linkIn(mail.text, "/owner/l/"));
  const claimed = page.waitForResponse((res) => res.url().endsWith("/api/owner/claims") && res.status() === 402);
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  expect(await (await claimed).json()).toMatchObject({ name, email, email_verified: true });
  await expect(page.getByText("Checkout test", { exact: true })).toBeVisible();
});
