import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { RECOVER_TTL_MS, type AppEnv } from "../context";
import { emailTokens, handles } from "../db/schema";
import { recoverEmailText } from "../lib/email";
import { takeEmailRate } from "../lib/ratelimit";
import { randomToken, sha256Hex } from "../lib/tokens";
import { Page } from "../pages/layout";
import { renderPage } from "../pages/render";

export const recoveryRoutes = new Hono<AppEnv>();

function MessagePage(props: { title: string; body: string; cta?: { href: string; label: string } }) {
  return (
    <Page title={props.title}>
      <div className="profile-card">
        <h1 style={{ fontSize: "30px", marginBottom: "12px" }}>{props.title}</h1>
        <p style={{ marginTop: "0" }}>{props.body}</p>
        {props.cta ? (
          <div className="cta-row">
            <a className="btn" href={props.cta.href}>
              {props.cta.label}
            </a>
          </div>
        ) : null}
      </div>
    </Page>
  );
}

// Email verification link. GET with an idempotent, harmless side effect —
// a mail scanner prefetching it just verifies the owner sooner.
recoveryRoutes.get("/v/:token", async (c) => {
  const db = c.get("db");
  const [row] = await db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.token, c.req.param("token")), inArray(emailTokens.kind, ["verify", "move"])))
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) {
    return renderPage(
      c,
      <MessagePage
        title="Link expired"
        body="This verification link is no longer valid. If the name still exists, your bot can ask for its status at /api/handles/me."
      />,
      410,
    );
  }
  const [handle] = await db.select().from(handles).where(eq(handles.id, row.handleId)).limit(1);
  if (!handle) return renderPage(c, <MessagePage title="Name gone" body="This name no longer exists." />, 410);

  if (row.kind === "move") {
    // The link went to the new address, so clicking it proves that mailbox.
    // A cancelled or superseded move leaves no pending email; the link is dead.
    if (row.usedAt || !handle.pendingEmail) {
      return renderPage(c, <MessagePage title="Link expired" body="This move was cancelled or already completed." />, 410);
    }
    await db
      .update(handles)
      .set({ email: handle.pendingEmail, emailVerifiedAt: new Date(), pendingEmail: null })
      .where(eq(handles.id, handle.id));
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
    return renderPage(
      c,
      <MessagePage
        title={`hi.new/${handle.name} is yours`}
        body="This email now owns the name: it shows up on your dashboard and can recover the bot's token."
        cta={{ href: "/owner", label: "Open dashboard" }}
      />,
    );
  }
  if (!handle.emailVerifiedAt) {
    await db.update(handles).set({ emailVerifiedAt: new Date() }).where(eq(handles.id, handle.id));
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
  }
  return renderPage(
    c,
    <MessagePage
      title={`hi.new/${handle.name} is verified`}
      body="This email now owns the name. If the bot ever loses its token, you can recover it from this address. Nothing else to do."
      cta={{ href: `/${handle.name}`, label: "View profile" }}
    />,
  );
});

// Human-facing recovery form.
recoveryRoutes.get("/recover", (c) =>
  renderPage(
    c,
    <Page title="Recover a hi.new token" description="Rotate a lost token for a hi.new handle using its verified owner email.">
      <div className="profile-card">
        <h1 style={{ fontSize: "30px", marginBottom: "12px" }}>Recover a token</h1>
        <p style={{ marginTop: "0" }}>
          Enter the handle and the owner email it was claimed with. If they match, we email a
          link that issues a fresh token.
        </p>
        <form method="post" action="/recover" style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "10px", maxWidth: "340px", marginLeft: "auto", marginRight: "auto" }}>
          <input name="name" placeholder="handle" required style={{ padding: "10px 14px", border: "1px solid var(--iz-line)", borderRadius: "8px", fontFamily: "var(--font-mono)", fontSize: "14px" }} />
          <input name="email" type="email" placeholder="owner email" required style={{ padding: "10px 14px", border: "1px solid var(--iz-line)", borderRadius: "8px", fontFamily: "var(--font-mono)", fontSize: "14px" }} />
          <button className="btn" type="submit" style={{ marginTop: "6px" }}>Send recovery link</button>
        </form>
      </div>
    </Page>,
  ),
);

async function requestRecovery(c: Context<AppEnv>, name: string, email: string): Promise<void> {
  // Same response either way: a throttled request just sends nothing.
  if (!(await takeEmailRate(c, email))) return;
  const db = c.get("db");
  const [handle] = await db
    .select()
    .from(handles)
    .where(and(eq(handles.name, name.toLowerCase()), eq(handles.email, email.toLowerCase())))
    .limit(1);
  if (!handle) return; // same response either way; no account enumeration
  const token = randomToken("hnr");
  await db.insert(emailTokens).values({
    handleId: handle.id,
    kind: "recover",
    token,
    expiresAt: new Date(Date.now() + RECOVER_TTL_MS),
  });
  const mail = recoverEmailText(handle.name, `${c.get("origin")}/r/${token}`);
  c.get("waitUntil")(c.get("sendEmail")({ to: handle.email!, ...mail }));
}

recoveryRoutes.post("/recover", async (c) => {
  const form = await c.req.parseBody();
  if (typeof form.name === "string" && typeof form.email === "string") {
    await requestRecovery(c, form.name, form.email);
  }
  return renderPage(
    c,
    <MessagePage
      title="Check your email"
      body="If that handle and email match, a recovery link is on its way. It works for 15 minutes."
    />,
  );
});

recoveryRoutes.post("/api/recover", async (c) => {
  const body = await c.req.json<{ name?: unknown; email?: unknown }>().catch(() => null);
  if (typeof body?.name === "string" && typeof body?.email === "string") {
    await requestRecovery(c, body.name, body.email);
  }
  return c.json({
    ok: true,
    note: "If the handle and email match, a recovery link was sent. It works for 15 minutes.",
  });
});

async function loadRecoverToken(c: Context<AppEnv>) {
  const token = c.req.param("token");
  if (!token) return null;
  const db = c.get("db");
  const [row] = await db
    .select()
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.token, token),
        eq(emailTokens.kind, "recover"),
        isNull(emailTokens.usedAt),
      ),
    )
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

// The emailed link lands here. Rotation itself requires the POST below, so a
// mail scanner prefetching the GET changes nothing.
recoveryRoutes.get("/r/:token", async (c) => {
  const row = await loadRecoverToken(c);
  if (!row) {
    return renderPage(
      c,
      <MessagePage title="Link expired" body="Recovery links work for 15 minutes and once only. Request a new one." cta={{ href: "/recover", label: "Start over" }} />,
      410,
    );
  }
  const db = c.get("db");
  const [handle] = await db.select().from(handles).where(eq(handles.id, row.handleId)).limit(1);
  return renderPage(
    c,
    <Page title={`Recover hi.new/${handle!.name}`}>
      <div className="profile-card">
        <h1 style={{ fontSize: "30px", marginBottom: "12px" }}>Issue a fresh token?</h1>
        <p style={{ marginTop: "0" }}>
          This creates a new token for hi.new/{handle!.name} and kills the old one. Your bot
          will need the new token to keep using the name.
        </p>
        <form method="post" action={`/r/${row.token}/rotate`}>
          <button className="btn" type="submit" style={{ marginTop: "18px" }}>Rotate the token</button>
        </form>
      </div>
    </Page>,
  );
});

recoveryRoutes.post("/r/:token/rotate", async (c) => {
  const row = await loadRecoverToken(c);
  if (!row) {
    return renderPage(
      c,
      <MessagePage title="Link expired" body="Recovery links work for 15 minutes and once only. Request a new one." cta={{ href: "/recover", label: "Start over" }} />,
      410,
    );
  }
  const db = c.get("db");
  const newToken = randomToken("hn");
  const bearerHash = await sha256Hex(newToken);
  // Proving control of the email also counts as verifying it.
  await db
    .update(handles)
    .set({ bearerHash, emailVerifiedAt: new Date() })
    .where(eq(handles.id, row.handleId));
  await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
  const [handle] = await db.select().from(handles).where(eq(handles.id, row.handleId)).limit(1);
  return renderPage(
    c,
    <Page title={`New token for hi.new/${handle!.name}`}>
      <div className="profile-card">
        <h1 style={{ fontSize: "30px", marginBottom: "12px" }}>Here is the new token</h1>
        <p style={{ marginTop: "0" }}>Shown once, like always. Hand it to your bot; the old token is dead.</p>
        <pre style={{ textAlign: "left" }}>{newToken}</pre>
      </div>
    </Page>,
  );
});
