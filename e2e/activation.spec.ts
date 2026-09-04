import { expect, test } from "@playwright/test";
import { captureScreenshot, claimViaApi, expectNoHorizontalOverflow, latestMailTo, signIn, unique } from "./helpers";

test("activation: hi says hello, invite with a purpose, first message, all tracked live", async ({ browser, page, request }, testInfo) => {
  const name = unique("e2e-act");
  const friend = unique("e2e-pal");
  const friendEmail = `${friend}@example.com`;

  await page.goto("/");
  await page.getByPlaceholder("yourname").fill(name);
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${name}/setup`));
  await page.getByRole("button", { name: "Set up your bot" }).click();
  const code = (await page.locator("#bot-prompt").textContent())!.match(/hns_[\w-]+/)![0];
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Your bot is live." })).toBeVisible();

  await expect(page.locator("#panel-invite")).toContainText("Send a friend an invite:");
  await expect(page.locator("#setup-nudge")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "50-live-bot-not-checked-in");

  const swap = await request.post("/api/setup", { data: { code } });
  expect(swap.status()).toBe(200);
  const { token, next_steps } = await swap.json();
  expect(next_steps[0]).toContain("welcome message");
  const inbox = await request.get("/api/inbox", { headers: { authorization: `Bearer ${token}` } });
  const mail = await inbox.json();
  expect(mail.messages[0].from).toBe("hi");
  expect(mail.messages[0].body).toContain(`Hi ${name}`);
  await request.post("/api/inbox/ack", { headers: { authorization: `Bearer ${token}` }, data: { ids: [mail.messages[0].id] } });
  const hi = await request.post("/api/dm/hi", { headers: { authorization: `Bearer ${token}` }, data: { body: "hi", enc: "none" } });
  expect((await hi.json()).reply_queued).toBe(true);

  await expect(page.locator("#setup-nudge")).toHaveCount(0, { timeout: 10_000 });
  await captureScreenshot(page, testInfo, "51-live-invite");

  await expect(page.locator("#panel-invite")).toContainText("Send a friend an invite:");
  await page.getByRole("button", { name: /swap bot tips/ }).click();
  const inviteText = await page.locator("#invite-text").textContent();
  expect(inviteText).toContain("wants to swap bot tips with yours");
  const link = inviteText!.match(/https?:\/\/\S+\/i\/hni_[\w-]+/)![0];
  await captureScreenshot(page, testInfo, "52-live-invite-made");

  const pal = await claimViaApi(request, friend, friendEmail);
  const palCtx = await browser.newContext();
  const palPage = await palCtx.newPage();
  await palPage.goto(link);
  await expect(palPage.locator(".said")).toContainText("swap the most helpful bots");
  await captureScreenshot(palPage, testInfo, "53-friend-sees-purpose");
  await signIn(palPage, friendEmail);
  await palPage.goto(link);
  await palPage.getByRole("button", { name: "Approve" }).click();
  await expect(palPage.getByRole("heading", { name: "Your bots are connected" })).toBeVisible();
  await expect(palPage.locator(".copy-panel-text")).toContainText(`Say hi to hi.new/${name}`);
  await captureScreenshot(palPage, testInfo, "54-friend-connected-say-this");

  await expect(page.locator("#panel-connected")).toContainText(`Connected to hi.new/${friend}.`, { timeout: 10_000 });
  await captureScreenshot(page, testInfo, "55-live-connected");

  const receipts = await (await request.get("/api/inbox", { headers: { authorization: `Bearer ${token}` } })).json();
  const redeemed = receipts.messages.find((m: any) => m.tag === "invite");
  expect(JSON.parse(redeemed.body)).toMatchObject({ event: "invite.redeemed", name: friend, message: expect.stringContaining("swap the most helpful bots") });

  const palInbox = await (await request.get("/api/inbox", { headers: { authorization: `Bearer ${pal.token}` } })).json();
  expect(palInbox.messages.some((m: any) => m.from === name && m.tag === "granted" && m.body.includes("swap the most helpful bots"))).toBe(true);

  const dm = await request.post(`/api/dm/${friend}`, {
    headers: { authorization: `Bearer ${token}` },
    data: { body: "Most useful thing I learned this week: ship the loop, not the feature.", enc: "none" },
  });
  expect(dm.status()).toBe(201);
  await palCtx.close();
});
