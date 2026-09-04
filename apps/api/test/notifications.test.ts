import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { notificationDestinations } from "../src/db/schema";
import { deliverNotificationDestination } from "../src/lib/notification-destinations";
import { call, connect, makeTestApp, signup } from "./helpers";

const grokUrl =
  "https://api2.cursor.sh/automations/webhook/01234567-89ab-cdef-0123-456789abcdef";

describe("notification destinations", () => {
  test("stores private Grok configuration encrypted and manages redacted metadata", async () => {
    const { app, db } = await makeTestApp();
    const bot = await signup(app, "wake-bot");
    const generatedUrl = "https://automations.grok.example/v2/hooks/opaque-id";
    const generatedKey = "future-key-format";

    const created = await call(app, "POST", "/api/notifications", {
      token: bot.token,
      body: {
        kind: "webhook",
        name: "hi.new inbox",
        endpoint: {
          url: generatedUrl,
          headers: { "X-Grok-Auth": generatedKey },
        },
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.destination).toMatchObject({
      kind: "webhook",
      name: "hi.new inbox",
      active: true,
    });
    expect(JSON.stringify(created.json)).not.toContain(generatedKey);
    expect(JSON.stringify(created.json)).not.toContain("opaque-id");

    const [stored] = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.handleId, 1));
    expect(stored!.endpointEnc).not.toContain("grok.example");
    expect(stored!.endpointEnc).not.toContain(generatedKey);

    const listed = await call(app, "GET", "/api/notifications", {
      token: bot.token,
    });
    expect(listed.status).toBe(200);
    expect(listed.json.destinations).toHaveLength(1);
    expect(JSON.stringify(listed.json)).not.toContain(generatedKey);

    const paused = await call(
      app,
      "PATCH",
      `/api/notifications/${created.json.destination.id}`,
      { token: bot.token, body: { active: false, name: "Paused inbox" } },
    );
    expect(paused.json.destination).toMatchObject({
      active: false,
      name: "Paused inbox",
    });

    const removed = await call(
      app,
      "DELETE",
      `/api/notifications/${created.json.destination.id}`,
      { token: bot.token },
    );
    expect(removed.json.deleted).toBe(true);
  });

  test("wakes Grok with authenticated, content-free inbox metadata", async () => {
    const pending: Promise<unknown>[] = [];
    const { app } = await makeTestApp({
      waitUntil: (promise) => pending.push(promise),
    });
    const alice = await signup(app, "alice-wake");
    const bob = await signup(app, "bob-wake");
    await connect(app, alice, bob);
    await Promise.allSettled(pending.splice(0));

    const inbox = await call(app, "GET", "/api/inbox/headers", {
      token: alice.token,
    });
    if (inbox.json.messages.length > 0) {
      await call(app, "POST", "/api/inbox/ack", {
        token: alice.token,
        body: {
          ids: inbox.json.messages.map((message: { id: number }) => message.id),
        },
      });
    }

    const created = await call(app, "POST", "/api/notifications", {
      token: alice.token,
      body: {
        kind: "webhook",
        endpoint: {
          url: grokUrl,
          headers: { Authorization: "Bearer crsr_wake_secret" },
        },
      },
    });
    expect(created.status).toBe(201);

    const originalFetch = globalThis.fetch;
    const requests: Array<{
      url: string;
      authorization: string | null;
      body: string;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        body: String(init?.body ?? ""),
      });
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    try {
      const sent = await call(app, "POST", "/api/dm/alice-wake", {
        token: bob.token,
        body: { body: "private message body", enc: "none" },
      });
      expect(sent.status).toBe(201);
      await Promise.allSettled(pending.splice(0));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: grokUrl,
      authorization: "Bearer crsr_wake_secret",
      body: JSON.stringify({ event: "inbox.new", to: "alice-wake", unread: 1 }),
    });
    expect(requests[0]!.body).not.toContain("private message body");
    expect(requests[0]!.body).not.toContain("bob-wake");

    const listed = await call(app, "GET", "/api/notifications", {
      token: alice.token,
    });
    expect(listed.json.destinations[0]).toMatchObject({
      failure_count: 0,
      last_error: null,
    });
    expect(listed.json.destinations[0].last_success_at).not.toBeNull();
  });

  test("formats the same event for a Slack destination", async () => {
    const { app, db } = await makeTestApp();
    const bot = await signup(app, "slack-bot");
    const created = await call(app, "POST", "/api/notifications", {
      token: bot.token,
      body: {
        kind: "slack",
        endpoint: { url: "https://hooks.slack.com/services/T000/B000/secret" },
      },
    });
    expect(created.status).toBe(201);
    const [stored] = await db.select().from(notificationDestinations);

    const originalFetch = globalThis.fetch;
    let body = "";
    globalThis.fetch = (async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const result = await deliverNotificationDestination(
        "test-notification-encryption-key",
        stored!,
        { event: "inbox.new", to: "slack-bot", unread: 2 },
      );
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(JSON.parse(body)).toEqual({
      text: "New hi.new inbox activity for slack-bot. 2 unread.",
    });
  });

  test("refuses private destination storage without an encryption key", async () => {
    const { app } = await makeTestApp({ notificationEncryptionKey: "" });
    const bot = await signup(app, "no-key-bot");
    const unavailable = await call(app, "POST", "/api/notifications", {
      token: bot.token,
      body: {
        kind: "slack",
        endpoint: { url: "https://hooks.slack.com/services/T000/B000/secret" },
      },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.json).toEqual({
      error: "notification_storage_unavailable",
      hint: "The service is missing NOTIFICATION_ENCRYPTION_KEY.",
    });
  });

  test("keeps adapter configuration inside endpoint", async () => {
    const { app } = await makeTestApp();
    const bot = await signup(app, "clean-schema-bot");

    const flat = await call(app, "POST", "/api/notifications", {
      token: bot.token,
      body: {
        kind: "webhook",
        url: "https://example.com/hook",
        bearer_token: "obsolete",
      },
    });
    expect(flat.status).toBe(400);

    const slackHeaders = await call(app, "POST", "/api/notifications", {
      token: bot.token,
      body: {
        kind: "slack",
        endpoint: {
          url: "https://hooks.slack.com/services/T000/B000/secret",
          headers: { Authorization: "not-supported" },
        },
      },
    });
    expect(slackHeaders.status).toBe(400);
  });

  test("enforces the destination cap under concurrent creates", async () => {
    const { app } = await makeTestApp();
    const bot = await signup(app, "destination-cap-bot");
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        call(app, "POST", "/api/notifications", {
          token: bot.token,
          body: {
            kind: "webhook",
            name: `Webhook ${index}`,
            endpoint: { url: `https://example.com/hooks/${index}` },
          },
        }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(10);
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(1);
  });
});
