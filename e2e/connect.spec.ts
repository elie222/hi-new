import { expect, test } from "@playwright/test";
import { captureScreenshot, claimViaApi, expectNoHorizontalOverflow, signIn, unique } from "./helpers";

test("dashboard: invite a bot, the other owner approves in one click, both see the contact", async ({ browser, request }, testInfo) => {
  const a = unique("e2e-alice");
  const b = unique("e2e-bob");
  const aEmail = `${a}@example.com`;
  const bEmail = `${b}@example.com`;
  const alice = await claimViaApi(request, a, aEmail);
  const bob = await claimViaApi(request, b, bEmail);

  const aliceCtx = await browser.newContext();
  const alicePage = await aliceCtx.newPage();
  await signIn(alicePage, aEmail, { testInfo, prefix: "21" });
  await expect(alicePage.getByRole("heading", { name: "Your bots" })).toBeVisible();
  await expect(alicePage.locator(".convo .convo-name", { hasText: /^hi$/ })).toBeVisible();
  await expect(alicePage.getByText("This bot hasn’t chatted with anyone yet.")).toHaveCount(0);
  await alicePage.getByRole("button", { name: "Invite a bot" }).click();
  await expect(alicePage.getByRole("dialog")).toBeVisible();
  await captureScreenshot(alicePage, testInfo, "25-dashboard-invite-dialog");
  await alicePage.getByRole("dialog").getByRole("button", { name: "Create message" }).click();
  await expect(alicePage.getByRole("dialog")).toBeVisible();
  const shareMessage = await alicePage.getByRole("dialog").locator(".copy-panel-text").textContent();
  expect(shareMessage).toContain("Hey, I’d like our bots to chat.");
  expect(shareMessage).not.toContain("with hi.new/");
  const link = shareMessage?.match(/https?:\/\/\S+\/i\/hni_[\w-]+/)?.[0];
  expect(link).toMatch(/\/i\/hni_/);
  await expect(alicePage.getByRole("dialog").getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(alicePage.getByRole("dialog").getByText("Not opened yet")).toHaveCount(0);
  await expectNoHorizontalOverflow(alicePage);
  await captureScreenshot(alicePage, testInfo, "26-dashboard-invite-link");

  const bobCtx = await browser.newContext();
  const bobPage = await bobCtx.newPage();
  await bobPage.goto(link!);
  await expect(bobPage.getByRole("heading", { name: "Connect these bots?" })).toBeVisible();
  await expect(bobPage.locator(".connection-new")).toHaveText("no name yet");
  await expect(bobPage.getByRole("link", { name: "Get your bot a name" })).toHaveAttribute("href", `/?link=${link!.split("/i/")[1]}&from=${a}`);
  await expect(bobPage.getByRole("link", { name: "Already have a bot? Sign in" })).toBeVisible();
  await expect(bobPage.getByText(a, { exact: true })).toBeVisible();
  await expect(bobPage.locator(".copy-panel-text")).toBeVisible();
  await expect(bobPage.locator(".copy-panel-text")).toContainText(`Connect me to hi.new/${a}:`);
  await expect(bobPage.locator(".copy-panel-text")).toContainText(`${link}.md`);
  await expect(bobPage.locator(".copy-panel").getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(bobPage.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await captureScreenshot(bobPage, testInfo, "27-invite-signed-out");
  await signIn(bobPage, bEmail);
  await bobPage.goto(link!);
  await expect(bobPage.getByText(b, { exact: true })).toBeVisible();
  await expect(bobPage.getByRole("combobox", { name: "Your bot" })).toHaveCount(0);
  await expectNoHorizontalOverflow(bobPage);
  await captureScreenshot(bobPage, testInfo, "28-invite-ready-to-approve");
  await bobPage.getByRole("button", { name: "Approve" }).click();
  await expect(bobPage.getByRole("heading", { name: "Your bots are connected" })).toBeVisible();
  await expect(bobPage.locator(".copy-panel-text")).toContainText(`Say hi to hi.new/${a}`);
  await captureScreenshot(bobPage, testInfo, "29-invite-connected");

  const dm = await request.post(`/api/dm/${b}`, {
    headers: { authorization: `Bearer ${alice.token}` },
    data: { body: "hello from e2e", enc: "none" },
  });
  expect(dm.status()).toBe(201);
  const inbox = await request.get("/api/inbox", { headers: { authorization: `Bearer ${bob.token}` } });
  expect(await inbox.text()).toContain("hello from e2e");

  await bobPage.goto("/owner");
  const bobConvo = bobPage.locator(".convo", { hasText: a });
  await expect(bobConvo).toContainText("hello from e2e");
  await expect(bobConvo.locator(".pair img")).toBeVisible();
  await bobConvo.locator("summary").click();
  await expect(bobConvo.getByRole("link", { name: `hi.new/${a}` })).toHaveAttribute("href", `/${a}`);
  await captureScreenshot(bobPage, testInfo, "30-recipient-dashboard-activity");
  await alicePage.goto("/owner");
  const aliceConvo = alicePage.locator(".convo", { hasText: b });
  await expect(aliceConvo).toContainText("hello from e2e");
  await aliceConvo.locator("summary").click();
  await expect(aliceConvo.getByRole("link", { name: `hi.new/${b}` })).toHaveAttribute("href", `/${b}`);
  await expect(alicePage.locator(".copy-panel")).toHaveCount(0);
  await captureScreenshot(alicePage, testInfo, "31-sender-dashboard-activity");

  await bobPage.goto(link!);
  await expect(bobPage.getByRole("heading", { name: "Link unavailable" })).toBeVisible();
  await captureScreenshot(bobPage, testInfo, "32-invite-link-spent");
  await aliceCtx.close();
  await bobCtx.close();
});

test("public profile: shared card, no sign-in, just how to connect; groups still work end to end", async ({ browser, request }, testInfo) => {
  const a = unique("e2e-ann");
  const b = unique("e2e-ben");
  const c = unique("e2e-cara");
  const ann = await claimViaApi(request, a, `${a}@example.com`);
  const ben = await claimViaApi(request, b, `${b}@example.com`);
  const cara = await claimViaApi(request, c, `${c}@example.com`);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/${b}`);
  await expect(anonPage.getByText(`hi.new/${b}`, { exact: true })).toBeVisible();
  await expect(anonPage.getByRole("link", { name: "Get your own name" })).toBeVisible();
  await expect(anonPage.getByRole("button", { name: "Message me" })).toHaveCount(0);
  await expectNoHorizontalOverflow(anonPage);
  await captureScreenshot(anonPage, testInfo, "33-public-bot-profile");
  await anon.close();

  const mk = await request.post("/api/groups", {
    headers: { authorization: `Bearer ${ann.token}` },
    data: { name: "Book club" },
  });
  expect(mk.status()).toBe(201);
  const group = await mk.json();
  const inv = await request.post(`/api/groups/${group.id}/invites`, {
    headers: { authorization: `Bearer ${ann.token}` },
  });
  expect(inv.status()).toBe(201);
  const { invite: { url: groupLink } } = await inv.json();
  expect(groupLink).toMatch(/\/g\/hngi_/);

  const benCtx = await browser.newContext();
  const benPage = await benCtx.newPage();
  await signIn(benPage, `${b}@example.com`);
  await benPage.goto(`/${b}`);
  await expect(benPage.getByRole("link", { name: "Manage your bot" })).toBeVisible();
  await expect(benPage.getByRole("link", { name: "Share" })).toHaveAttribute("href", /x\.com\/intent\/post/);
  await benPage.goto(groupLink);
  await expect(benPage.getByRole("heading", { name: "invited your bot to “Book club”" })).toBeVisible();
  await captureScreenshot(benPage, testInfo, "41-group-invite-ready");
  await benPage.getByRole("button", { name: "Join" }).click();
  await expect(benPage.getByText("is in “Book club”")).toBeVisible();
  await captureScreenshot(benPage, testInfo, "42-group-joined");
  const groups = await request.get("/api/groups", { headers: { authorization: `Bearer ${ben.token}` } });
  expect(await groups.text()).toContain("Book club");

  const caraCtx = await browser.newContext();
  const caraPage = await caraCtx.newPage();
  await signIn(caraPage, `${c}@example.com`);
  await caraPage.goto(groupLink);
  await expect(caraPage.getByRole("heading", { name: "invited your bot to “Book club”" })).toBeVisible();
  await caraPage.getByRole("button", { name: "Join" }).click();
  await expect(caraPage.getByText("is in “Book club”")).toBeVisible();
  const caraGroups = await request.get("/api/groups", { headers: { authorization: `Bearer ${cara.token}` } });
  expect(await caraGroups.text()).toContain("Book club");
  await captureScreenshot(caraPage, testInfo, "45-group-link-reused");
  await caraCtx.close();
  await benCtx.close();
});
