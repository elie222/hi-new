import { expect, test, type APIRequestContext } from "@playwright/test";
import { captureScreenshot, claimViaApi, signIn, unique } from "./helpers";

test.use({ timezoneId: "America/Los_Angeles" });

async function send(
  request: APIRequestContext,
  fromToken: string,
  to: string,
  body: string,
): Promise<void> {
  const response = await request.post(`/api/dm/${to}`, {
    headers: { authorization: `Bearer ${fromToken}` },
    data: { body, enc: "none" },
  });
  expect(response.status(), await response.text()).toBe(201);
}

test("activity feed shows a bot conversation moving from queued to read to saved history", async ({ page, request }, testInfo) => {
  const aliceName = unique("e2e-convo-alice");
  const bobName = unique("e2e-convo-bob");
  const aliceEmail = `${aliceName}@example.com`;
  const bobEmail = `${bobName}@example.com`;
  const alice = await claimViaApi(request, aliceName, aliceEmail);
  const bob = await claimViaApi(request, bobName, bobEmail);

  const invite = await request.post("/api/invites", {
    headers: { authorization: `Bearer ${alice.token}` },
  });
  expect(invite.status()).toBe(201);
  const inviteToken = (await invite.json()).token;
  const redeemed = await request.post(`/api/invites/${inviteToken}/redeem`, {
    headers: { authorization: `Bearer ${bob.token}` },
  });
  expect(redeemed.status()).toBe(200);

  const lines = [
    "Can your human do Thursday at 7?",
    "Yes — Thursday at 7 works. Rooftop or inside?",
    "Rooftop. I’ll hold a table for four.",
    "Booked. I sent both humans the calendar invite.",
  ];
  await send(request, alice.token, bobName, lines[0]!);
  await send(request, bob.token, aliceName, lines[1]!);
  await send(request, alice.token, bobName, lines[2]!);
  await send(request, bob.token, aliceName, lines[3]!);

  await signIn(page, aliceEmail);
  // The conversation is a collapsed row on the bot card; expand to see the chat.
  // (Every bot also has hi's welcome thread, so pick Bob's row explicitly.)
  const expand = () => page.locator(".convo", { hasText: bobName }).locator("> summary").click();
  const convo = page.locator(".convo", { hasText: bobName });
  const chat = convo.locator(".chat");
  await expand();
  for (const line of lines) await expect(chat.getByText(line, { exact: true })).toBeVisible();
  const firstTime = chat.locator('time[data-local-time="clock"]').first();
  const firstIso = await firstTime.getAttribute("datetime");
  expect(firstIso).not.toBeNull();
  const localTime = await page.evaluate(
    (value) => new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date(value)),
    firstIso!,
  );
  await expect(firstTime).toHaveText(localTime);
  await expect(chat.getByText("Not read yet")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "57-activity-conversation-live");

  const bobInbox = await request.get("/api/inbox", {
    headers: { authorization: `Bearer ${bob.token}` },
  });
  expect(bobInbox.status()).toBe(200);
  await page.reload();
  await expand();
  for (const line of lines) await expect(chat.getByText(line, { exact: true })).toBeVisible();
  await expect(chat.locator(".status", { hasText: /^Read$/ })).toHaveCount(4);
  await captureScreenshot(page, testInfo, "58-activity-conversation-read");

  const aliceInboxResponse = await request.get("/api/inbox", {
    headers: { authorization: `Bearer ${alice.token}` },
  });
  expect(aliceInboxResponse.status()).toBe(200);
  const aliceInbox = await aliceInboxResponse.json();
  const newestReply = aliceInbox.messages.find((message: { body?: string }) => message.body === lines[3]);
  expect(newestReply).toBeTruthy();
  const acknowledged = await request.post("/api/inbox/ack", {
    headers: { authorization: `Bearer ${alice.token}` },
    data: { ids: [newestReply.id] },
  });
  expect(acknowledged.status()).toBe(200);

  await page.reload();
  await expand();
  await expect(chat.getByText(lines[3]!, { exact: true })).toBeVisible();
  // Status details live in the hidden-until-hover meta, so count instead.
  await expect(chat.locator(".status", { hasText: "Read, saved" })).toHaveCount(1);
  await expect(chat.getByText(lines[1]!, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "59-activity-conversation-after-ack");
});
