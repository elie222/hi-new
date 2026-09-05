import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

export type Mail = { to: string; subject: string; text: string };

export const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export const uniquePaidName = () => `p${Math.random().toString(36).slice(2, 6)}`;

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path,
  });
  await testInfo.attach(name, { contentType: "image/png", path });
}

export async function mail(request: APIRequestContext): Promise<Mail[]> {
  return (await request.get("/__e2e/mail")).json();
}

export async function latestMailTo(request: APIRequestContext, to: string, subjectPart?: string): Promise<Mail> {
  await expect
    .poll(async () => (await mail(request)).find((m) => m.to === to && (!subjectPart || m.subject.includes(subjectPart))), {
      timeout: 5000,
    })
    .toBeTruthy();
  return (await mail(request)).find((m) => m.to === to && (!subjectPart || m.subject.includes(subjectPart)))!;
}

export function linkIn(text: string, pathPrefix: string): string {
  const url = text.match(/https?:\/\/[^\s]+/g)?.map((value) => new URL(value)).find((value) => value.pathname.startsWith(pathPrefix));
  if (!url) throw new Error(`no ${pathPrefix} URL in mail`);
  return url.pathname + url.search;
}

// A bot claimed straight through the API (what a bot does on its own).
export async function claimViaApi(request: APIRequestContext, name: string, email: string): Promise<{ token: string }> {
  const res = await request.post("/api/handles", { data: { name, email } });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  const verify = await latestMailTo(request, email, `Verify hi.new/${name}`);
  expect((await request.get(linkIn(verify.text, "/v/"))).status()).toBe(200);
  return { token: body.token };
}

// Owner sign-in through the real magic-link flow, in this page's context.
export async function signIn(
  page: Page,
  email: string,
  screenshots?: { testInfo: TestInfo; prefix: string },
): Promise<void> {
  await page.goto("/owner");
  if (screenshots) await captureScreenshot(page, screenshots.testInfo, `${screenshots.prefix}a-owner-sign-in`);
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  if (screenshots) await captureScreenshot(page, screenshots.testInfo, `${screenshots.prefix}b-owner-check-email`);
  const m = await latestMailTo(page.request, email);
  await page.goto(linkIn(m.text, "/owner/l/"));
  if (screenshots) await captureScreenshot(page, screenshots.testInfo, `${screenshots.prefix}c-owner-confirm`);
  await page.getByRole("link", { name: "Continue to dashboard" }).click();
  await expect(page).toHaveURL(/\/owner$/);
  if (screenshots) await captureScreenshot(page, screenshots.testInfo, `${screenshots.prefix}d-owner-dashboard`);
}

// Guard for the mobile project: nothing wider than the viewport.
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `page is ${scrollWidth}px wide in a ${innerWidth}px viewport`).toBeLessThanOrEqual(innerWidth);
}
