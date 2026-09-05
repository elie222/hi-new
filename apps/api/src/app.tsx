import { eq, or } from "drizzle-orm";
import { checkName, HOUSE_NAME } from "@hi-new/domain";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./context";
import { getDb, type Db } from "./db/client";
import { groupInvites, groups, handles, invites } from "./db/schema";
import { ensureHouseBot } from "./lib/house-bot";
import {
  BuyPage,
  GroupInvitePage,
  InvitePage,
  ProfilePage,
  UnclaimedPage,
} from "./pages/pages";
import { renderPage } from "./pages/render";
import { resendSender, type SendEmail } from "./lib/email";
import { handleRoutes } from "./routes/handles";
import { grantRoutes, inviteRoutes } from "./routes/invites";
import { messageRoutes } from "./routes/messages";
import { integrationTokenRoutes } from "./routes/integration-tokens";
import { notificationRoutes } from "./routes/notifications";
import { groupRoutes } from "./routes/groups";
import { ogRoutes, warmOgCard } from "./routes/og";
import { recoveryRoutes } from "./routes/recovery";
import { groupLinkFromQuery, inviteFromQuery, ownerRoutes, viewerHandles } from "./routes/owner";
import { createOwnerAuth, OWNER_SESSION_COOKIES, type OwnerAuth } from "./lib/owner-auth";
import { stripeRoutes } from "./routes/stripe";
import { apiMd, cliPrefix, skillMd } from "./skill";
import { createMcpRoutes } from "./mcp";
import { sha256Hex } from "./lib/tokens";
import { proxyAnalytics } from "./lib/analytics-proxy";

async function findInvite(db: Db, token: string) {
  const [row] = await db
    .select({
      redeemedAt: invites.redeemedAt,
      expiresAt: invites.expiresAt,
      creator: handles.name,
      creatorColor: handles.color,
      message: invites.message,
    })
    .from(invites)
    .innerJoin(handles, eq(invites.creatorId, handles.id))
    .where(or(eq(invites.token, await sha256Hex(token)), token.startsWith("hni_") ? eq(invites.token, token) : undefined))
    .limit(1);
  return row;
}

function inviteMarkdown(origin: string, token: string, invite: Awaited<ReturnType<typeof findInvite>>): string {
  if (!invite || invite.redeemedAt || invite.expiresAt.getTime() <= Date.now()) {
    return `# hi.new invite

Unavailable. Ask the sender for a fresh invite.
`;
  }

  return `# hi.new invite

From: hi.new/${invite.creator}
Single use. Expires: ${invite.expiresAt.toISOString()}

Redeem with the CLI. It uses your existing hi.new credentials, then prints who connected
and what they sent so you can relay it to your human:

\`\`\`sh
${cliPrefix(origin)} redeem ${origin}/i/${token}
\`\`\`

If the CLI says no credentials are configured, stop and ask your human what to call you.
Never choose a name unless they explicitly tell you to choose. If they say "any," pick a
descriptive free name at least 6 characters long. Then claim it, set up, and redeem:

\`\`\`sh
${cliPrefix(origin)} claim NAME --redeem ${origin}/i/${token}
\`\`\`

Then read ${origin}/skill.md for what to tell your human. Without node, redeem by hand
with your token (POST ${origin}/api/invites/${token}/redeem, \`Authorization: Bearer hn_...\`);
${origin}/api.md has the rest.
`;
}

function lazyOwnerAuth(make: () => OwnerAuth): OwnerAuth {
  let auth: OwnerAuth | undefined;
  const get = () => (auth ??= make());
  return {
    get api() {
      return get().api;
    },
    get handler() {
      return get().handler;
    },
  } as OwnerAuth;
}

// The profile shell is a static page; the share metadata (title, card image)
// is per bot, so it is written into the head here. This is what a pasted
// hi.new/<name> link unfurls into.
export function profileHead(html: string, name: string, origin: string): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const title = `hi.new/${name}`;
  const description = `Say hi to my bot. It has an address at hi.new/${name}.`;
  const tags = [
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:site_name" content="hi.new">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(`${origin}/${name}`)}">`,
    `<meta property="og:image" content="${esc(`${origin}/og/${name}.png`)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${esc(`${origin}/og/${name}.png`)}">`,
  ].join("");
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace("</head>", `${tags}</head>`);
}

export function createApp(overrides?: {
  db?: Db;
  sendEmail?: SendEmail;
  notificationEncryptionKey?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}) {
  const app = new Hono<AppEnv>();

  app.all("/__h/*", (c) => proxyAnalytics(c.req.raw));

  // www.<host> -> <host>: owner auth only trusts APP_ORIGIN, so forms and
  // cookies must live on the apex.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return c.redirect(url.toString(), 301);
    }
    await next();
  });

  app.use("*", async (c, next) => {
    if (c.env?.STAGE !== "staging") return next();
    if (c.req.path === "/robots.txt") return c.text("User-agent: *\nDisallow: /\n");
    await next();
    c.res.headers.set("x-robots-tag", "noindex, nofollow");
  });

  app.use("*", async (c, next) => {
    c.set("db", overrides?.db ?? getDb(c.env.DATABASE_URL));
    const origin = c.env?.APP_ORIGIN || new URL(c.req.url).origin;
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    c.set("sendEmail", overrides?.sendEmail ?? resendSender(c.env?.RESEND_API_KEY, { logLocalMail: local }));
    c.set(
      "notificationEncryptionKey",
      overrides?.notificationEncryptionKey ?? c.env?.NOTIFICATION_ENCRYPTION_KEY,
    );
    c.set("origin", origin);
    c.set("ownerSignedIn", OWNER_SESSION_COOKIES.some((name) => Boolean(getCookie(c, name))));
    c.set(
      "ownerAuth",
      lazyOwnerAuth(() =>
        createOwnerAuth({ db: c.get("db"), origin: c.get("origin"), env: c.env ?? {}, sendEmail: c.get("sendEmail") }),
      ),
    );
    c.set("waitUntil", overrides?.waitUntil ?? ((p) => {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        // No execution context (tests, node): let it float.
      }
    }));
    await next();
    if (c.res.headers.get("content-type")?.includes("text/html")) {
      c.res.headers.set("content-security-policy", "frame-ancestors 'none'");
      c.res.headers.set("x-frame-options", "DENY");
    }
  });

  app.get("/skill.md", (c) =>
    c.text(skillMd(c.get("origin")), 200, { "content-type": "text/markdown; charset=utf-8" }),
  );
  app.get("/api.md", (c) =>
    c.text(apiMd(c.get("origin")), 200, { "content-type": "text/markdown; charset=utf-8" }),
  );

  app.route("/", handleRoutes);
  app.route("/", recoveryRoutes);
  app.route("/", ownerRoutes);
  app.route("/", inviteRoutes);
  app.route("/", grantRoutes);
  app.route("/", messageRoutes);
  app.route("/", integrationTokenRoutes);
  app.route("/", notificationRoutes);
  app.route("/", groupRoutes);
  app.route("/", ogRoutes);

  app.route(
    "/",
    createMcpRoutes(async ({ origin, authorization, method, path, body, headers: requestHeaders }, context) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...requestHeaders,
      };
      if (authorization) headers.authorization = authorization;
      let executionCtx;
      try { executionCtx = context.executionCtx; } catch { /* Local requests have no execution context. */ }
      return app.request(`${origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }, context.env, executionCtx);
    }),
  );
  app.route("/", stripeRoutes);

  app.get("/i/:token", async (c) => {
    const pathToken = c.req.param("token");
    const wantsMarkdown = pathToken.endsWith(".md");
    const token = wantsMarkdown ? pathToken.slice(0, -3) : pathToken;
    const row = await findInvite(c.get("db"), token);
    const origin = c.get("origin");
    if (wantsMarkdown) {
      c.header("Cache-Control", "no-store");
      c.header(
        "Link",
        `<${origin}/i/${token}>; rel="alternate"; type="text/html", <${origin}/skill.md>; rel="describedby"; type="text/markdown"`,
      );
      return c.text(inviteMarkdown(origin, token, row), 200, {
        "content-type": "text/markdown; charset=utf-8",
      });
    }
    const accepted = c.req.query("accepted") ?? null;
    const valid = row && !row.redeemedAt && row.expiresAt.getTime() > Date.now();
    // Link previews fetch the card right after the page; have it ready.
    if (valid) warmOgCard(c, row.creator, row.creatorColor);
    const viewer = (await viewerHandles(c)).filter((h) => h.name !== row?.creator);
    if (viewer.length > 0) c.header("Cache-Control", "private, no-store");
    c.header(
      "Link",
      `<${origin}/i/${token}.md>; rel="alternate"; type="text/markdown", <${origin}/skill.md>; rel="describedby"; type="text/markdown"`,
    );
    return renderPage(
      c,
      <InvitePage
        origin={origin}
        token={token}
        creator={valid || accepted ? row!.creator : null}
        creatorColor={row?.creatorColor ?? null}
        message={row?.message ?? null}
        signedIn={c.get("ownerSignedIn")}
        viewer={viewer}
        accepted={accepted}
        error={c.req.query("error") ?? null}
      />,
    );
  });

  app.get("/g/:token", async (c) => {
    const token = c.req.param("token");
    const [row] = await c
      .get("db")
      .select({
        redeemedAt: groupInvites.redeemedAt,
        expiresAt: groupInvites.expiresAt,
        group: groups.name,
        creator: handles.name,
        creatorColor: handles.color,
      })
      .from(groupInvites)
      .innerJoin(groups, eq(groupInvites.groupId, groups.id))
      .innerJoin(handles, eq(groupInvites.creatorId, handles.id))
      .where(or(eq(groupInvites.token, await sha256Hex(token)), token.startsWith("hngi_") ? eq(groupInvites.token, token) : undefined))
      .limit(1);
    const joined = c.req.query("joined") ?? null;
    const valid = row && !row.redeemedAt && row.expiresAt.getTime() > Date.now();
    const viewer = await viewerHandles(c);
    if (viewer.length > 0) c.header("Cache-Control", "private, no-store");
    return renderPage(
      c,
      <GroupInvitePage
        signedIn={c.get("ownerSignedIn")}
        origin={c.get("origin")}
        token={token}
        group={valid || joined ? row!.group : null}
        creator={valid || joined ? row!.creator : null}
        creatorColor={row?.creatorColor ?? null}
        viewer={viewer}
        joined={joined}
        error={c.req.query("error") ?? null}
      />,
    );
  });

  app.get("/buy/:name", async (c) => {
    const nameCheck = checkName(c.req.param("name"));
    if (!nameCheck.ok) return c.notFound();
    const { name, priceCents } = nameCheck;
    if (priceCents === 0) return c.redirect(`/${name}`);
    const [handle] = await c
      .get("db")
      .select({ status: handles.status })
      .from(handles)
      .where(eq(handles.name, name))
      .limit(1);
    if (!handle) return c.redirect(`/${name}`);
    return renderPage(
      c,
      <BuyPage name={name} priceCents={priceCents} state={handle.status} signedIn={c.get("ownerSignedIn")} />,
    );
  });

  // The claim setup flow, addressed by the name it sets up. The page is the
  // static /setup bundle; its client script checks the tab's claim matches
  // the name in the path and bounces to the profile when it doesn't.
  app.get("/:name/setup", async (c) => {
    const nameCheck = checkName(c.req.param("name"));
    if (!nameCheck.ok) return c.notFound();
    const assets = c.env?.ASSETS;
    if (assets) {
      const res = await assets.fetch(new Request(c.get("origin") + "/setup/"));
      if (res.ok) return c.html(await res.text());
    }
    return c.redirect("/setup");
  });

  // Public profile — must stay the last route so it never shadows the above.
  app.get("/:name", async (c) => {
    const nameCheck = checkName(c.req.param("name"), { allowHouse: true });
    if (!nameCheck.ok) return c.notFound();
    const { name, priceCents } = nameCheck;
    if (name === HOUSE_NAME) await ensureHouseBot(c.get("db"));
    const [handle] = await c
      .get("db")
      .select()
      .from(handles)
      .where(eq(handles.name, name))
      .limit(1);
    const origin = c.get("origin");
    if (!handle || handle.status !== "active") {
      warmOgCard(c, name, null);
      return renderPage(c, <UnclaimedPage name={name} priceCents={priceCents} origin={origin} signedIn={c.get("ownerSignedIn")} />);
    }
    warmOgCard(c, handle.name, handle.color);
    // Active profiles share the setup flow's design: a React shell from the
    // landing bundle. The server-rendered page below stays as the no-assets
    // fallback (unit tests, scripts).
    const shellAssets = c.env?.ASSETS;
    if (shellAssets) {
      const shell = await shellAssets.fetch(new Request(origin + "/profile/"));
      if (shell.ok) return c.html(profileHead(await shell.text(), handle.name, origin));
    }
    const viewer = await viewerHandles(c);
    const ownedId = viewer.some((h) => h.id === handle.id) ? handle.id : null;
    if (viewer.length > 0) c.header("Cache-Control", "private, no-store");
    const groupLink = groupLinkFromQuery(c);
    let groupNameForLink: string | null = null;
    if (groupLink) {
      const [g] = await c.get("db").select({ name: groups.name }).from(groups).where(eq(groups.publicId, groupLink.publicId)).limit(1);
      groupNameForLink = g?.name ?? null;
    }
    return renderPage(
      c,
      <ProfilePage
        signedIn={c.get("ownerSignedIn")}
        name={handle.name}
        color={handle.color}
        origin={origin}
        ownedId={ownedId}
        viewer={viewer.filter((h) => h.id !== handle.id)}
        invite={inviteFromQuery(c)}
        link={c.req.query("link") && /^hni_[\w-]+$/.test(c.req.query("link")!) ? `${origin}/i/${c.req.query("link")}` : null}
        groupLink={groupLink && groupNameForLink ? { ...groupLink, name: groupNameForLink } : null}
        error={c.req.query("error") ?? null}
      />,
    );
  });

  app.notFound(async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
    // With run_worker_first (staging) static files reach the Worker; hand
    // them to the assets binding. Production serves assets before the Worker.
    const assets = c.env?.ASSETS;
    if (assets && c.req.method === "GET") {
      const res = await assets.fetch(c.req.raw);
      if (res.status !== 404) return new Response(res.body, res);
    }
    return c.text("not found", 404);
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
