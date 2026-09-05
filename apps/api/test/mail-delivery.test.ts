import { expect, test } from "bun:test";
import { resendSender } from "../src/lib/email";

test("mail delivery forwards retry keys and reports failures without provider content", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let status = 200;
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://api.resend.com/emails");
    requests.push(init!);
    return new Response("provider detail with private data", { status });
  }) as typeof fetch;
  try {
    const send = resendSender("test-resend-key");
    const mail = { to: "owner@example.com", subject: "Renew", text: "Your name expires soon." };
    await send({ ...mail, idempotencyKey: "renewal:1:2030:1" });
    expect(new Headers(requests[0]!.headers).get("Idempotency-Key")).toBe("renewal:1:2030:1");
    expect(JSON.parse(String(requests[0]!.body))).not.toHaveProperty("idempotencyKey");
    await send(mail);
    expect(new Headers(requests[1]!.headers).has("Idempotency-Key")).toBe(false);
    status = 503;
    await expect(send(mail)).rejects.toThrow("Email delivery failed (503)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
