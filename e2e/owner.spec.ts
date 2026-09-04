import { expect, test } from "@playwright/test";
import { captureScreenshot, claimViaApi, expectNoHorizontalOverflow, latestMailTo, linkIn, signIn, unique } from "./helpers";

test("dashboard settings: toggles, owner email move with confirmation, empty state", async ({ page, request }, testInfo) => {
  const name = unique("e2e-set");
  const email = `${name}@example.com`;
  const bot = await claimViaApi(request, name, email);
  await signIn(page, email);
  await captureScreenshot(page, testInfo, "46-owner-dashboard");

  const account = page.locator("summary", { hasText: "Account" });
  await expect(account.locator(".menu-chevron")).toBeVisible();
  await account.click();
  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible();
  await captureScreenshot(page, testInfo, "47-owner-account-menu");
  await page.getByRole("heading", { name: "Your bots" }).click();
  await expect(signOut).toBeHidden();
  await account.click();
  await expect(signOut).toBeVisible();
  await account.click();
  await expect(signOut).toBeHidden();

  const more = page.locator(".handle-actions summary").first();
  await more.click();
  await page.getByRole("button", { name: "New group" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await captureScreenshot(page, testInfo, "47a-owner-new-group-dialog");
  await page.getByRole("dialog").getByPlaceholder("Group name").fill("Project room");
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click(),
  ]);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator(".copy-panel-text")).toContainText("/g/hngi_");
  const firstGroupLink = (await page.getByRole("dialog").locator(".copy-panel-text").textContent())!.match(/https?:\/\/\S+\/g\/hngi_[\w-]+/)![0];
  await expect(page.getByRole("dialog").getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Replace link" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "47b-owner-new-group-created");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.goto("/owner");

  const group = page.locator("details.convo", { hasText: "Group: Project room" });
  const groupSummary = group.locator("summary");
  await expect(groupSummary.locator(".pair img")).toHaveCount(0);
  await expect(groupSummary).not.toContainText("1 member");
  await expect(groupSummary).not.toContainText("no messages yet");
  await expect(groupSummary.getByRole("button", { name: "Invite to group" })).toBeVisible();
  await captureScreenshot(page, testInfo, "47c-owner-group-row");
  await groupSummary.click();
  await expect(group).toHaveAttribute("open", "");
  await expect(group.getByText("1 member", { exact: true })).toHaveCount(0);
  await groupSummary.click();
  await groupSummary.getByRole("button", { name: "Invite to group" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator(".copy-panel-text")).toContainText(firstGroupLink);
  await expect(page.getByRole("dialog")).not.toContainText("Create a message");
  await expect(page.getByRole("dialog")).not.toContainText("Create an invite link");
  await expect(group).not.toHaveAttribute("open", "");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await more.click();
  await page.getByRole("button", { name: "Invite links" }).click();
  const linksDialog = page.getByRole("dialog");
  await expect(linksDialog.getByRole("heading", { name: "Active invite links" })).toBeVisible();
  await expect(linksDialog.getByText("Group: Project room", { exact: true })).toBeVisible();
  await expect(linksDialog).not.toContainText("/g/");
  await captureScreenshot(page, testInfo, "47d-owner-invite-links");
  await Promise.all([page.waitForEvent("load"), linksDialog.getByRole("button", { name: "Revoke" }).click()]);
  await expect(page.getByRole("dialog").getByText("No active invite links.")).toBeVisible();
  expect(await (await request.get(firstGroupLink)).text()).toContain("Link unavailable");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await Promise.all([
    page.waitForEvent("load"),
    groupSummary.getByRole("button", { name: "Invite to group" }).click(),
  ]);
  await expect(page.getByRole("dialog").locator(".copy-panel-text")).toContainText("/g/hngi_");
  await expect(page.getByRole("dialog")).not.toContainText("Create a message");
  await expect(page.getByRole("dialog")).not.toContainText("Create an invite link");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await more.click();
  await page.getByRole("button", { name: "Settings" }).first().click();
  const alerts = page.getByRole("switch", { name: "Email me about new messages" });
  await expect(alerts).toHaveAttribute("aria-checked", "true");
  await captureScreenshot(page, testInfo, "48-owner-settings");
  // The switch flips, then posts after its slide; wait for the reload.
  await Promise.all([page.waitForEvent("load"), alerts.click()]);
  await more.click();
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByRole("switch", { name: "Email me about new messages" })).toHaveAttribute("aria-checked", "false");
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "49a-owner-settings-notifications-off");

  const transcriptHelp = page.locator('summary[aria-label="About transcript retention"]');
  const transcriptTooltip = page.locator(".help-tip");
  await expect(transcriptTooltip).toBeHidden();
  await transcriptHelp.click();
  await expect(transcriptTooltip).toBeVisible();
  await expect(transcriptTooltip).toContainText("Only unencrypted messages");
  const [tooltipBox, settingsBox] = await Promise.all([
    transcriptTooltip.boundingBox(),
    transcriptHelp.locator("xpath=ancestor::dialog").boundingBox(),
  ]);
  expect(tooltipBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(settingsBox!.x - 1);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(settingsBox!.x + settingsBox!.width + 1);
  await captureScreenshot(page, testInfo, "49aa-owner-settings-help");

  const transcripts = page.getByRole("switch", { name: "Keep transcripts for 90 days" });
  await expect(transcripts).toHaveAttribute("aria-checked", "true");
  await Promise.all([page.waitForEvent("load"), transcripts.click()]);
  await more.click();
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByRole("switch", { name: "Keep transcripts for 90 days" })).toHaveAttribute("aria-checked", "false");
  await captureScreenshot(page, testInfo, "49b-owner-settings-transcripts-off");

  const next = `${name}-next@example.com`;
  await page.getByPlaceholder("Move to another email").fill(next);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Move", exact: true }).click()]);
  await more.click();
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByText(`Moving to`)).toBeVisible();
  await captureScreenshot(page, testInfo, "50-owner-email-move-pending");
  const move = await latestMailTo(request, next, `Take over hi.new/${name}`);
  await page.goto(linkIn(move.text, "/v/"));
  await expect(page.getByRole("heading", { name: `hi.new/${name} is yours` })).toBeVisible();
  await captureScreenshot(page, testInfo, "51-owner-email-move-confirmed");
  const me = await request.get("/api/handles/me", { headers: { authorization: `Bearer ${bot.token}` } });
  expect((await me.json()).email).toBe(next);

  await page.goto("/owner");
  await expect(page.getByRole("heading", { name: "No bots here yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get a name" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureScreenshot(page, testInfo, "52-owner-empty-dashboard");
});

test("the bot's token cannot re-point a verified owner email", async ({ request }) => {
  const name = unique("e2e-lock");
  const bot = await claimViaApi(request, name, `${name}@example.com`);
  const res = await request.patch("/api/handles/me", {
    headers: { authorization: `Bearer ${bot.token}` },
    data: { email: "mallory@example.com" },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toBe("email_locked");
});
