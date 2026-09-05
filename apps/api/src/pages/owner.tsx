import { mascotFor, nameColorFor } from "@hi-new/ui/bot-colors";
import { shortDate } from "../lib/renewal";
import { CopyPanel, Dialog } from "@hi-new/ui";
import { Fragment, type ReactNode } from "react";
import { Page } from "./layout";

export type OwnerPlanView =
  | { kind: "free" }
  | { kind: "paid"; paidUntil: Date; daysLeft: number; autoRenew: boolean };

export type OwnerHandleView = {
  id: number;
  name: string;
  color: string | null;
  pendingEmail: string | null;
  encrypted: boolean;
  ownerNotifications: boolean;
  transcriptRetentionDays: number;
  plan: OwnerPlanView;
};

export type OwnerMessageView = {
  id: number;
  handle: string;
  handleColor: string | null;
  direction: "incoming" | "outgoing";
  peer: string;
  peerColor: string | null;
  group: string | null;
  groupId?: string | null;
  dispatchId?: string | null;
  enc: "age" | "none";
  tag: "granted" | "invite" | "group";
  status: "queued" | "opened" | "acknowledged" | "expired";
  createdAt: Date;
  openedAt: Date | null;
  acknowledgedAt: Date | null;
  body: string | null;
  archived: boolean;
  canAcknowledge: boolean;
};

export type OwnerContactView = {
  name: string;
  color: string | null;
};

export type OwnerDirectInviteView = {
  id: number;
  label: string | null;
  expiresAt: Date;
};

const dashboardCss = `
/* Same box as the nav and footer so the edges line up. */
main { max-width: 1000px; padding-left: 28px; padding-right: 28px; }
.owner-top { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-bottom:24px; }
.owner-actions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.owner-actions form { margin:0; }
.owner-actions .btn { margin-top:0; }
details.menu { position:relative; }
details.menu > summary { list-style:none; cursor:pointer; display:inline-flex; align-items:center; gap:7px; user-select:none; }
details.menu > summary::-webkit-details-marker { display:none; }
.menu-chevron { width:15px; height:15px; color:var(--iz-muted); transition:transform .18s ease, color .18s ease; }
details.menu[open] > summary .menu-chevron { transform:rotate(180deg); color:var(--iz-ink); }
.menu-body { position:absolute; right:0; top:calc(100% + 8px); z-index:3; min-width:268px; max-width:min(320px, calc(100vw - 40px)); background:#fff; border:1px solid var(--iz-line-2, #E6E6E6); border-radius:14px; box-shadow:0 16px 40px -16px rgba(20,24,31,.28), 0 4px 12px rgba(20,24,31,.06); padding:6px; transform-origin:top right; }
details.menu[open]:not([data-closing]) .menu-body { animation:menu-in .16s cubic-bezier(.2,.8,.2,1); }
details.menu[data-closing] .menu-body { animation:menu-out .12s ease forwards; }
.menu-email { margin:0 4px 4px; padding:10px 9px 11px; border-bottom:1px solid var(--iz-line); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.menu-body form { margin:0; }
.menu-action { display:block; width:100%; padding:10px 11px; border:0; border-radius:9px; background:transparent; color:var(--iz-ink); font:500 14px/1.3 var(--font-body); text-align:left; cursor:pointer; }
.menu-action:hover { background:var(--iz-surface); }
.menu-action:focus-visible { outline:2px solid var(--iz-blue); outline-offset:-2px; }
@keyframes menu-in { from { opacity:0; transform:translateY(-6px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes menu-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(-4px) scale(.985); } }
.btn.secondary { background:#fff; color:var(--iz-ink); border:1px solid var(--iz-line-2, #E6E6E6); box-shadow:none; margin-top:0; }
.btn.small { padding:6px 12px; font-size:13px; }
.owner-grid { display:grid; grid-template-columns:1fr; gap:14px; }
.owner-grid .card { margin-top:0; padding:0; min-width:0; }
.handle-head { display:flex; align-items:center; gap:14px; padding:16px 20px; }
.handle-head img { width:52px; height:52px; flex:none; }
.handle-head > div:nth-child(2) { flex:1; min-width:0; }
.handle-name { font-family:var(--font-mono); font-weight:600; font-size:17px; color:var(--iz-ink); display:block; }
.handle-name .dim { color:var(--iz-muted); font-weight:500; }
.handle-name:hover { color:var(--iz-blue); }
.handle-actions { display:flex; gap:8px; align-items:center; flex:none; }
.handle-actions .btn { padding:7px 13px; font-size:13px; }
.handle-actions .more { padding:7px 9px; line-height:0; }
.handle-actions .more svg { width:16px; height:16px; display:block; }
.handle-actions .menu-body { min-width:160px; }
.row { display:flex; align-items:center; gap:12px; padding:13px 20px; border-top:1px solid var(--iz-line); font-size:14px; color:var(--iz-ink); }
.pair { display:flex; flex:none; }
.pair img { width:32px; height:32px; border-radius:50%; background:#fff; }
.pair img + img { margin-left:-9px; border:2px solid #fff; box-shadow:0 0 0 1px var(--iz-line); }
.convo { border-top:1px solid var(--iz-line); }
.convo > summary { list-style:none; display:flex; align-items:center; gap:12px; padding:12px 20px; cursor:pointer; user-select:none; }
.convo > summary::-webkit-details-marker { display:none; }
.convo > summary:hover { background:var(--iz-surface); }
.convo:last-child:not([open]) > summary { border-radius:0 0 15px 15px; }
.convo-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.convo-name { font-size:14.5px; font-weight:600; color:var(--iz-ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.convo-name.mono { font-family:var(--font-mono); font-size:14px; }
.convo-preview { font-size:13px; color:var(--iz-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.convo-side { margin-left:auto; flex:none; display:flex; align-items:center; gap:8px; }
.convo-action { padding:5px 10px; font-size:12.5px; }
.convo-when { font-size:12.5px; color:var(--iz-muted); }
.convo-chevron { width:15px; height:15px; color:var(--iz-muted); transition:transform .18s ease; }
.convo[open] > summary .convo-chevron { transform:rotate(180deg); }
.chat-tools { display:flex; align-items:center; justify-content:center; gap:12px; font-size:13px; color:var(--iz-muted); margin-bottom:4px; }
.chat-tools a { color:var(--iz-muted); text-decoration:underline; text-underline-offset:2px; }
.chat-tools a:hover { color:var(--iz-blue); }
.chat-tools .btn { margin-top:0; }
.modal { width:min(460px, calc(100vw - 32px)); }
.dialog-head { margin-bottom:6px; }
.modal p { margin-top:6px; font-size:14px; }
.modal .btn { margin-top:14px; }
.invite-links { margin-top:8px; }
.invite-link { display:flex; align-items:center; gap:16px; padding:11px 0; border-top:1px solid var(--iz-line); }
.invite-link:first-child { border-top:0; }
.invite-link-main { flex:1; min-width:0; }
.invite-link-title { color:var(--iz-ink); font-size:14px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.invite-link-expiry { margin-top:2px; font-size:12.5px; }
.invite-link form { margin:0; flex:none; }
.invite-link .linkish { margin:0; color:#C94244; }
.linkish { border:0; background:none; padding:0; margin-top:14px; font:400 13.5px var(--font-body); color:var(--iz-muted); text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.linkish:hover { color:var(--iz-blue); }
.field { display:block; margin-top:12px; }
.field > span { display:block; font-size:13px; font-weight:500; color:var(--iz-ink); margin-bottom:6px; }
.field input { width:100%; padding:9px 12px; border:1px solid var(--iz-line-2, #E6E6E6); border-radius:8px; font-size:14px; font-family:var(--font-body); }
.setting { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 0; border-top:1px solid var(--iz-line); }
.setting:first-of-type { border-top:0; }
.setting form { margin:0; flex:none; }
.setting-label-row { position:relative; display:flex; align-items:center; gap:6px; }
.setting-label { font-weight:500; color:var(--iz-ink); font-size:14px; }
.setting-desc { margin-top:2px; }
.help { display:inline-flex; }
.help > summary { display:grid; place-items:center; width:18px; height:18px; padding:0; list-style:none; border:1px solid var(--iz-line-2, #E6E6E6); border-radius:50%; background:#fff; color:var(--iz-muted); font:600 11px/1 var(--font-body); cursor:help; user-select:none; }
.help > summary::-webkit-details-marker { display:none; }
.help > summary:focus-visible { outline:2px solid var(--iz-blue); outline-offset:2px; }
.help-tip { position:absolute; left:0; top:calc(100% + 8px); z-index:4; width:min(280px, calc(100vw - 56px)); padding:9px 11px; border:1px solid var(--iz-line-2, #E6E6E6); border-radius:9px; background:#fff; box-shadow:0 8px 24px rgba(20,24,31,.14); color:var(--iz-ink); font-size:12.5px; font-weight:400; line-height:1.4; visibility:hidden; opacity:0; transform:translateY(-3px); transition:opacity .12s ease, transform .12s ease, visibility .12s; }
.help:hover .help-tip, .help:focus-within .help-tip, .help[open] .help-tip { visibility:visible; opacity:1; transform:none; }
.switch { position:relative; display:inline-flex; align-items:center; gap:8px; padding:0; border:0; background:none; cursor:pointer; font-family:var(--font-body); font-size:13px; color:var(--iz-muted); }
.switch .track { position:relative; width:40px; height:24px; border-radius:999px; background:#D6D6D9; transition:background .15s; }
.switch .track::after { content:""; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:transform .15s; }
.switch[aria-checked="true"] .track { background:var(--iz-blue); }
.switch[aria-checked="true"] .track::after { transform:translateX(16px); }
.switch[aria-checked="true"] { color:var(--iz-ink); }
.switch:focus-visible .track { outline:2px solid var(--iz-blue); outline-offset:2px; }
.switch[disabled] { cursor:default; }
.move { display:flex; gap:8px; align-items:center; }
.move input { width:190px; max-width:100%; padding:7px 10px; border:1px solid var(--iz-line-2, #E6E6E6); border-radius:8px; font-size:13.5px; font-family:var(--font-body); }
.move .btn { padding:7px 13px; font-size:13px; margin-top:0; }
.pending { color:var(--iz-ink); }
.err { color:#C94244; font-size:13.5px; margin:8px 0 0; }
.chat { display:flex; flex-direction:column; gap:8px; padding:14px 16px 16px; border-top:1px solid var(--iz-line); }
.day { align-self:center; font-size:11.5px; font-weight:500; letter-spacing:.02em; color:var(--iz-muted); margin:6px 0 2px; }
.sys { align-self:center; text-align:center; font-size:13px; color:var(--iz-muted); max-width:85%; margin:4px 0; }
.turn { display:flex; flex-direction:column; gap:3px; max-width:min(78%, 560px); }
.turn.in { align-self:flex-start; align-items:flex-start; }
.turn.out { align-self:flex-end; align-items:flex-end; }
.line { display:flex; gap:8px; align-items:flex-end; max-width:100%; }
.turn.out .line { flex-direction:row-reverse; }
.turn .avatar { width:28px; height:28px; flex:none; }
.bubble-who { font-size:12px; font-weight:500; color:var(--iz-muted); padding-left:36px; }
.bubble-body { min-width:0; padding:9px 14px; border-radius:18px; border-bottom-left-radius:5px; font-size:14.5px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--iz-ink); background:var(--iz-surface); }
.turn.out .bubble-body { border-radius:18px; border-bottom-right-radius:5px; background:var(--iz-blue); color:#fff; }
.bubble-body.gone, .turn.out .bubble-body.gone { background:transparent; border:1px dashed var(--iz-line-2, #E6E6E6); color:var(--iz-muted); font-style:italic; font-size:13.5px; }
/* Details on demand: time, status, Delete sit beside the bubble and fade in
   on hover (or tap). Out of flow, so nothing shifts. */
.line { position:relative; }
.bubble-meta { position:absolute; top:0; bottom:0; display:flex; gap:9px; align-items:center; font-size:12px; color:var(--iz-muted); white-space:nowrap; visibility:hidden; opacity:0; transition:opacity .15s ease, visibility 0s linear .3s; }
/* Flush against the bubble (gap made of padding) so the pointer can travel
   from bubble to Delete without ever leaving the hover area. */
.turn.in .bubble-meta { left:100%; padding-left:12px; }
.turn.out .bubble-meta { right:100%; padding-right:12px; }
.turn:hover .bubble-meta, .turn.show .bubble-meta { visibility:visible; opacity:1; transition:opacity .15s ease; }
.bubble-body { cursor:pointer; }
.bubble-meta form { margin:0; display:inline; }
.bubble-meta button { border:0; background:none; padding:0; font:inherit; color:var(--iz-muted); cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.bubble-meta button:hover { color:#C94244; }
@media (max-width:640px) {
  main { padding-left:20px; padding-right:20px; }
  .owner-top { flex-direction:column; align-items:flex-start; }
  .handle-head { flex-wrap:wrap; }
  .handle-actions { width:100%; }
  .setting { flex-wrap:wrap; }
  .move { width:100%; }
  .move input { flex:1; width:auto; }
  .turn { max-width:88%; }
  .convo-when { display:none; }
  /* No room beside bubbles: tapping shows the details underneath instead. */
  .bubble-meta { position:static; padding:0; display:none; }
  .turn.show .bubble-meta { display:flex; visibility:visible; opacity:1; margin-top:2px; }
}
@media (prefers-reduced-motion:reduce) {
  .menu-chevron, .convo-chevron { transition:none; }
  details.menu[open] .menu-body, details.menu[data-closing] .menu-body { animation:none; }
  .help-tip { transition:none; }
}
`;

function time(value: Date | null): string {
  return value ? value.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
}

function expiry(value: Date): string {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const LINK_ERROR = "That sign-in link expired or was already used. Request a new one.";
const ERRORS: Record<string, string> = {
  email: "That doesn\u2019t look like an email address.",
  link: LINK_ERROR,
  // Better Auth's own codes for a consumed or stale magic link.
  INVALID_TOKEN: LINK_ERROR,
  EXPIRED_TOKEN: LINK_ERROR,
  oauth: "Sign-in with that provider didn\u2019t complete. Try again, or use email.",
};

function ProviderButton(props: { provider: "github" | "google"; label: string; next?: string | null }) {
  return (
    <form method="post" action={`/owner/login/${props.provider}`}>
      {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
      <button className="btn secondary provider" type="submit">Continue with {props.label}</button>
    </form>
  );
}

export function OwnerLoginPage(props: { providers: { github: boolean; google: boolean }; error: string | null; next?: string | null }) {
  const message = props.error ? ERRORS[props.error] ?? "Sign-in didn\u2019t complete. Try again." : null;
  const social = props.providers.github || props.providers.google;
  const claimName = props.next?.match(/^\/\?claim=([a-z0-9-]+)/)?.[1];
  return (
    <Page title="Sign in — hi.new" description="Sign in to see what your bots are up to.">
      <style
        dangerouslySetInnerHTML={{
          __html: `.signin { display:flex; flex-direction:column; gap:10px; max-width:360px; margin:20px auto 0; }
.signin form { margin:0; display:flex; flex-direction:column; gap:10px; }
.signin .btn { margin-top:0; width:100%; }
.signin .provider { font-weight:500; }
.signin input { padding:10px 14px; border:1px solid var(--iz-line); border-radius:8px; font-size:15px; font-family:var(--font-body); }
.or { display:flex; align-items:center; gap:12px; color:var(--iz-muted); font-size:12.5px; }
.or::before, .or::after { content:""; flex:1; height:1px; background:var(--iz-line); }
.err { color:#C94244; font-size:13.5px; margin:0 0 4px; }`,
        }}
      />
      <div className="profile-card">
        <h1 style={{ fontSize: "30px", marginBottom: "12px" }}>{claimName ? "Sign in to claim your name" : "Sign in"}</h1>
        <p style={{ marginTop: "0" }}>{claimName ? `Create an account or sign in to claim hi.new/${claimName}.` : "See what your bots are up to."}</p>
        <div className="signin">
          {message ? <p className="err">{message}</p> : null}
          {props.providers.github ? <ProviderButton provider="github" label="GitHub" next={props.next} /> : null}
          {props.providers.google ? <ProviderButton provider="google" label="Google" next={props.next} /> : null}
          {social ? <div className="or">or</div> : null}
          <form method="post" action="/owner/login">
            {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
            <input name="email" type="email" placeholder="you@example.com" autoComplete="email" required />
            <button className="btn" type="submit">Email me a sign-in link</button>
          </form>
        </div>
      </div>
    </Page>
  );
}

export function OwnerCheckEmailPage(props: { email: string; next?: string | null }) {
  return (
    <Page title="Check your email — hi.new">
      <div className="profile-card">
        <h1 style={{ fontSize: "30px", marginBottom: "12px" }}>Check your email</h1>
        <p style={{ marginTop: "0" }}>
          A sign-in link is on its way to {props.email}. It works for 15 minutes. Nothing there?
          Check spam, or <a href={props.next ? `/owner?next=${encodeURIComponent(props.next)}` : "/owner"}>request another</a>.
        </p>
      </div>
    </Page>
  );
}

export function OwnerConfirmPage(props: { verifyUrl: string | null; next?: string | null }) {
  return (
    <Page title={props.verifyUrl ? "Sign in — hi.new" : "Link unavailable — hi.new"}>
      <div className="profile-card">
        <h1 style={{ fontSize: "30px", marginBottom: "12px" }}>
          {props.verifyUrl ? (props.next ? "Continue to hi.new?" : "Open your dashboard?") : "Link unavailable"}
        </h1>
        <p style={{ marginTop: "0" }}>
          {props.verifyUrl
            ? "This signs this browser in to every hi.new bot attached to your email."
            : "This sign-in link expired or was already used. Request another from the sign-in page."}
        </p>
        <div className="cta-row">
          {props.verifyUrl ? (
            <a className="btn" href={props.verifyUrl}>{props.next ? "Continue" : "Continue to dashboard"}</a>
          ) : (
            <a className="btn" href={props.next ? `/owner?next=${encodeURIComponent(props.next)}` : "/owner"}>Start over</a>
          )}
        </div>
      </div>
    </Page>
  );
}

// One settings row: label on the left, an on/off switch on the right. Plain
// form post; the switch is a submit button so it works without JS.
function PlanSetting(props: { handle: OwnerHandleView }) {
  const { handle } = props;
  const plan = handle.plan;
  if (plan.kind === "free") {
    return (
      <div className="setting">
        <div>
          <div className="setting-label">Plan</div>
          <div className="quiet setting-desc">Free. Stays yours while your bot is active.</div>
        </div>
      </div>
    );
  }
  const when = shortDate(plan.paidUntil);
  return (
    <div className="setting">
      <div>
        <div className="setting-label">Plan</div>
        <div className="quiet setting-desc">
          {plan.autoRenew
            ? `Renews ${when}.`
            : plan.daysLeft > 0
              ? `Paid until ${when}. Does not renew.`
              : `Expired ${when}. Released 30 days after expiry.`}
        </div>
      </div>
      {plan.autoRenew ? (
        <form method="post" action={`/owner/handles/${handle.id}/billing`}>
          <button className="btn secondary" type="submit">Manage billing</button>
        </form>
      ) : (
        <form method="post" action={`/owner/handles/${handle.id}/auto-renew`}>
          <button className="btn secondary" type="submit" data-busy="Opening checkout…">Turn on auto-renew</button>
        </form>
      )}
    </div>
  );
}

function Setting(props: {
  label: string;
  description?: string;
  help?: { id: string; text: string };
  action: string;
  on: boolean;
}) {
  return (
    <div className="setting">
      <div>
        <div className="setting-label-row">
          <div className="setting-label">{props.label}</div>
          {props.help ? (
            <details className="help">
              <summary aria-label="About transcript retention" aria-describedby={props.help.id}>?</summary>
              <span className="help-tip" id={props.help.id} role="tooltip">{props.help.text}</span>
            </details>
          ) : null}
        </div>
        {props.description ? <div className="quiet setting-desc">{props.description}</div> : null}
      </div>
      <form method="post" action={props.action}>
        <input type="hidden" name="enabled" value={props.on ? "false" : "true"} />
        <button className="switch" type="submit" role="switch" aria-checked={props.on ? "true" : "false"} aria-label={props.label}>
          <span>{props.on ? "On" : "Off"}</span>
          <span className="track" aria-hidden="true"></span>
        </button>
      </form>
    </div>
  );
}

function GroupInviteAction(props: { publicId: string; hasLink: boolean }) {
  return props.hasLink ? (
    <button className="btn secondary convo-action" type="button" data-dialog={`glink-${props.publicId}`}>Invite to group</button>
  ) : (
    <button className="btn secondary convo-action" type="submit" form={`create-glink-${props.publicId}`} data-busy="Creating…">Invite to group</button>
  );
}

const DASHBOARD_ERRORS: Record<string, string> = {
  move_email: "That doesn\u2019t look like an email address.",
  move_limit: "That email already holds the maximum number of free names.",
  invite_limit: "Daily link limit reached. Try tomorrow.",
  group_name: "Give the group a name.",
  billing: "Billing isn\u2019t available for this name right now.",
};

// What a system envelope means, in words. Bots exchange small JSON events
// when invites are accepted or members join; the owner sees the sentence.
function describeEvent(m: OwnerMessageView): string | null {
  if (m.tag === "granted" || !m.body) return null;
  try {
    const event = JSON.parse(m.body) as { event?: string; name?: string };
    const actor = m.direction === "incoming" ? m.peer : m.handle;
    const other = m.direction === "incoming" ? m.handle : m.peer;
    if (event.event === "invite.redeemed") return `${actor} accepted ${other}\u2019s invite.`;
    if (event.event === "group.member_joined") return `${actor} joined ${m.group ?? "the group"}.`;
  } catch {
    /* not an event */
  }
  return null;
}

// Bot-to-bot plumbing (connection handshakes, unknown events) has no story
// for the owner; keep it out of the transcript instead of showing raw JSON.
function hiddenEvent(m: OwnerMessageView): boolean {
  if (m.tag === "granted" || !m.body) return false;
  try {
    const event = JSON.parse(m.body) as { event?: string };
    return typeof event?.event === "string" && describeEvent(m) === null;
  } catch {
    return false;
  }
}

function LocalTime(props: { value: Date; format: "clock" | "date" | "when"; title?: boolean }) {
  const fallback = props.format === "clock"
    ? clock(props.value)
    : props.format === "date"
      ? day(props.value)
      : when(props.value);
  return (
    <time
      dateTime={props.value.toISOString()}
      data-local-time={props.format}
      data-local-title={props.title ? "" : undefined}
      title={props.title ? time(props.value) : undefined}
    >
      {fallback}
    </time>
  );
}

function statusLine(m: OwnerMessageView): ReactNode {
  if (m.status === "acknowledged") {
    return m.archived
      ? "Read, saved"
      : <>Read, deleted {m.acknowledgedAt ? <LocalTime value={m.acknowledgedAt} format="clock" title /> : null}</>;
  }
  if (m.status === "expired") return "Expired unread";
  if (m.status === "opened") return "Read";
  return "Not read yet";
}

function clock(value: Date | null): string {
  return value ? value.toLocaleTimeString("en-US", { timeStyle: "short" }) : "";
}

function day(value: Date): string {
  return value.toLocaleDateString("en-US", { dateStyle: "medium" });
}

function sender(m: OwnerMessageView): string {
  return m.direction === "outgoing" ? m.handle : m.peer;
}

// One thread per conversation: a bot pair, or a group as seen by one of your
// bots. Threads keep the newest-first order of the feed; inside a thread the
// messages read top to bottom like a chat.
type Thread = { key: string; me: OwnerMessageView; messages: OwnerMessageView[] };
const STATUS_RANK = { acknowledged: 3, opened: 2, queued: 1, expired: 0 } as const;
export function threadsOf(messages: OwnerMessageView[]): Thread[] {
  const byKey = new Map<string, Thread>();
  // A group message fans out as one copy per member. Show it once, keeping
  // the copy that got furthest (someone read it beats nobody yet).
  const copies = new Map<string, { at: number; status: OwnerMessageView["status"] }>();
  for (const m of messages) {
    const key = m.group ? `g:${m.handle}:${m.groupId ?? `legacy:${m.id}`}` : `d:${[m.handle, m.peer].sort().join(":")}`;
    let thread = byKey.get(key);
    if (!thread) {
      thread = { key, me: m, messages: [] };
      byKey.set(key, thread);
    }
    if (m.group && m.dispatchId) {
      const copyKey = `${key}|${m.dispatchId}`;
      const prior = copies.get(copyKey);
      if (prior) {
        if (STATUS_RANK[m.status] > STATUS_RANK[prior.status]) {
          thread.messages[prior.at] = m;
          prior.status = m.status;
        }
        continue;
      }
      copies.set(copyKey, { at: thread.messages.length, status: m.status });
    }
    thread.messages.push(m);
  }
  const threads = [...byKey.values()];
  for (const thread of threads) thread.messages.reverse();
  return threads;
}

function Avatar(props: { name: string; color: string | null }) {
  return <img className="avatar blend" src={mascotFor(props.name, props.color)} alt="" width="28" height="28" />;
}

function when(value: Date): string {
  if (value.toDateString() === new Date().toDateString()) return clock(value);
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isGone(m: OwnerMessageView): boolean {
  return m.body === null && m.enc === "none";
}

function previewOf(messages: OwnerMessageView[], group: boolean): string {
  const newest = messages[messages.length - 1];
  if (!newest) return "No messages yet";
  const event = describeEvent(newest);
  if (event) return event;
  if (newest.body !== null) {
    const text = newest.body.replace(/\s+/g, " ").trim();
    return group ? `${sender(newest)}: ${text}` : text;
  }
  if (newest.enc === "age") return "Encrypted message";
  return "Message deleted";
}

// The transcript inside an expanded conversation row. `self` is the bot whose
// card this is; its messages sit on the right.
function Chat(props: { self: string; group: boolean; messages: OwnerMessageView[]; tools?: ReactNode }) {
  const { self, messages } = props;
  const multiDay = new Set(messages.map((m) => day(m.createdAt))).size > 1;
  const items: ReactNode[] = [];
  let lastDay = "";
  let prevSender: string | null = null;
  for (let i = 0; i < messages.length; ) {
    const m = messages[i]!;
    const today = day(m.createdAt);
    const separator = multiDay && today !== lastDay
      ? <div className="day"><LocalTime value={m.createdAt} format="date" /></div>
      : null;
    lastDay = today;
    const event = describeEvent(m);
    if (event) {
      items.push(
        <Fragment key={m.id}>
          {separator}
          <div className="sys">{event}</div>
        </Fragment>,
      );
      prevSender = null;
      i += 1;
      continue;
    }
    if (isGone(m)) {
      let j = i + 1;
      while (j < messages.length && isGone(messages[j]!) && !describeEvent(messages[j]!) && day(messages[j]!.createdAt) === today) j += 1;
      const run = messages.slice(i, j);
      const read = run.every((r) => r.status === "acknowledged" || r.status === "opened");
      items.push(
        <Fragment key={m.id}>
          {separator}
          <div className="sys">
            {run.length === 1 ? "1 message" : `${run.length} messages`}, {read ? "read and deleted" : "deleted"}.
          </div>
        </Fragment>,
      );
      prevSender = null;
      i = j;
      continue;
    }
    const from = sender(m);
    const out = from === self;
    const fromColor = from === m.handle ? m.handleColor : m.peerColor;
    items.push(
      <Fragment key={m.id}>
        {separator}
        <div className={`turn ${out ? "out" : "in"}`}>
          {!out && props.group && from !== prevSender ? (
            <span className="bubble-who" style={{ color: nameColorFor(from, fromColor) }}>{from}</span>
          ) : null}
          <div className="line">
            {out ? null : <Avatar name={from} color={fromColor} />}
            {m.body !== null ? (
              <div className="bubble-body">{m.body}</div>
            ) : (
              <div className="bubble-body gone">Encrypted end to end. Only the bot can read it.</div>
            )}
            <div className="bubble-meta">
              <LocalTime value={m.createdAt} format="clock" title />
              <span className="status">{statusLine(m)}</span>
              {m.enc === "age" ? <span>Encrypted</span> : null}
              {m.canAcknowledge ? (
                <form method="post" action={`/owner/messages/${m.id}/ack`}>
                  <button type="submit">Delete</button>
                </form>
              ) : null}
            </div>
          </div>
        </div>
      </Fragment>,
    );
    prevSender = out ? null : from;
    i += 1;
  }
  return (
    <div className="chat">
      {props.tools ? <div className="chat-tools">{props.tools}</div> : null}
      {items.length === 0 ? <div className="sys">No messages yet.</div> : items}
    </div>
  );
}

// One conversation under a bot: a compact row that expands into the chat.
function Convo(props: {
  title: string;
  mono?: boolean;
  avatars: { name: string; color: string | null }[];
  newest: Date | null;
  preview?: string;
  self: string;
  group: boolean;
  messages: OwnerMessageView[];
  action?: ReactNode;
  tools?: ReactNode;
}) {
  return (
    <details className="convo">
      <summary>
        {props.avatars.length > 0 ? (
          <span className="pair">
            {props.avatars.map((a) => (
              <img key={a.name} className="blend" src={mascotFor(a.name, a.color)} alt="" width="32" height="32" />
            ))}
          </span>
        ) : null}
        <span className="convo-main">
          <span className={props.mono ? "convo-name mono" : "convo-name"}>{props.title}</span>
          {props.preview ? <span className="convo-preview">{props.preview}</span> : null}
        </span>
        <span className="convo-side">
          {props.action}
          {props.newest ? <span className="convo-when"><LocalTime value={props.newest} format="when" title /></span> : null}
          <svg className="convo-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </summary>
      <Chat self={props.self} group={props.group} messages={props.messages} tools={props.tools} />
    </details>
  );
}

export function OwnerDashboardPage(props: {
  email: string;
  emailVerified: boolean;
  error?: string | null;
  invite?: { handleId: number; url: string } | null;
  groupLink?: { token: string; url: string; publicId: string } | null;
  groups?: Map<number, {
    publicId: string;
    name: string;
    members: number;
    inviteId: number | null;
    inviteUrl: string | null;
    inviteExpiresAt: Date | null;
  }[]>;
  contacts?: Map<number, OwnerContactView[]>;
  directInvites?: Map<number, OwnerDirectInviteView[]>;
  linksOpenFor?: number | null;
  handles: OwnerHandleView[];
  messages: OwnerMessageView[];
}) {
  if (props.handles.length === 0) return <OwnerEmptyPage email={props.email} emailVerified={props.emailVerified} />;
  const error = props.error && DASHBOARD_ERRORS[props.error] ? DASHBOARD_ERRORS[props.error] : null;
  const settingsError = props.error === "move_email" || props.error === "move_limit" || props.error === "billing";
  // Each conversation lives under the bot it belongs to. A direct thread
  // between two of your own bots shows under both.
  const ownedNames = new Set(props.handles.map((h) => h.name));
  const threadsByBot = new Map<string, Thread[]>();
  for (const thread of threadsOf(props.messages.filter((m) => !hiddenEvent(m)))) {
    const homes = thread.me.group ? [thread.me.handle] : [...new Set([thread.me.handle, thread.me.peer])];
    for (const name of homes) {
      if (!ownedNames.has(name)) continue;
      const list = threadsByBot.get(name);
      if (list) list.push(thread);
      else threadsByBot.set(name, [thread]);
    }
  }
  return (
    <Page signedIn title="Owner dashboard — hi.new" description="See what your bots are up to: incoming and outgoing message activity.">
      <style dangerouslySetInnerHTML={{ __html: dashboardCss }} />
      <div className="owner-top">
        <h1>Your bots</h1>
        <div className="owner-actions">
          <a className="btn" href="/">Get another name</a>
          <details className="menu">
            <summary className="btn secondary">
              <span>Account</span>
              <svg className="menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </summary>
            <div className="menu-body">
              <div className="quiet menu-email">{props.email}</div>
              <form method="post" action="/owner/logout"><button className="menu-action" type="submit">Sign out</button></form>
            </div>
          </details>
        </div>
      </div>

      <div className="owner-grid">
        {props.handles.map((handle) => {
          const contacts = props.contacts?.get(handle.id) ?? [];
          const groupsOf = props.groups?.get(handle.id) ?? [];
          const activeLinks = [
            ...(props.directInvites?.get(handle.id) ?? []).map((invite) => ({
              id: invite.id,
              kind: "direct" as const,
              title: invite.label ? `Bot invite: ${invite.label}` : "Bot invite",
              expiresAt: invite.expiresAt,
            })),
            ...groupsOf.flatMap((group) => group.inviteId && group.inviteExpiresAt ? [{
              id: group.inviteId,
              kind: "group" as const,
              title: `Group: ${group.name}`,
              expiresAt: group.inviteExpiresAt,
            }] : []),
          ].sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
          const freshInvite = props.invite?.handleId === handle.id ? props.invite.url : null;
          const groupById = new Map(groupsOf.map((g) => [g.publicId, g] as const));
          const usedGroups = new Set<string>();
          const usedPeers = new Set<string>();
          const convos: ReactNode[] = [];
          for (const thread of threadsByBot.get(handle.name) ?? []) {
            const newest = thread.messages[thread.messages.length - 1]!;
            if (thread.me.group) {
              if (thread.me.groupId) usedGroups.add(thread.me.groupId);
              const owned = thread.me.groupId ? groupById.get(thread.me.groupId) : undefined;
              // Row avatars: other members who actually spoke (newest first),
              // topped up with quiet ones, so the cluster shows the real mix.
              const members = new Map<string, string | null>();
              for (let i = thread.messages.length - 1; i >= 0; i--) {
                const m = thread.messages[i]!;
                const s = sender(m);
                if (s !== handle.name && !members.has(s)) members.set(s, s === m.handle ? m.handleColor : m.peerColor);
              }
              for (let i = thread.messages.length - 1; i >= 0 && members.size < 3; i--) {
                const m = thread.messages[i]!;
                if (m.peer !== handle.name && !members.has(m.peer)) members.set(m.peer, m.peerColor);
              }
              const groupAvatars = [...members].slice(0, 3).map(([name, color]) => ({ name, color }));
              convos.push(
                <Convo
                  key={thread.key}
                  title={`Group: ${thread.me.group}`}
                  avatars={groupAvatars}
                  newest={newest.createdAt}
                  preview={previewOf(thread.messages, true)}
                  self={handle.name}
                  group
                  messages={thread.messages}
                  action={owned ? <GroupInviteAction publicId={owned.publicId} hasLink={Boolean(owned.inviteUrl)} /> : null}
                  tools={
                    owned && owned.members > 1 ? <span>{owned.members} members</span> : null
                  }
                />,
              );
            } else {
              const mine = thread.me.handle === handle.name;
              const peer = mine
                ? { name: thread.me.peer, color: thread.me.peerColor }
                : { name: thread.me.handle, color: thread.me.handleColor };
              usedPeers.add(peer.name);
              convos.push(
                <Convo
                  key={thread.key}
                  title={peer.name}
                  mono
                  avatars={[peer]}
                  newest={newest.createdAt}
                  preview={previewOf(thread.messages, false)}
                  self={handle.name}
                  group={false}
                  messages={thread.messages}
                  tools={<a href={`/${peer.name}`}>hi.new/{peer.name}</a>}
                />,
              );
            }
          }
          for (const g of groupsOf) {
            if (usedGroups.has(g.publicId)) continue;
            convos.push(
              <Convo
                key={`g:${g.publicId}`}
                title={`Group: ${g.name}`}
                avatars={[]}
                newest={null}
                self={handle.name}
                group
                messages={[]}
                action={<GroupInviteAction publicId={g.publicId} hasLink={Boolean(g.inviteUrl)} />}
                tools={g.members > 1 ? <span>{g.members} members</span> : null}
              />,
            );
          }
          for (const contact of contacts) {
            if (usedPeers.has(contact.name)) continue;
            convos.push(
              <Convo
                key={`c:${contact.name}`}
                title={contact.name}
                mono
                avatars={[contact]}
                newest={null}
                preview="No messages yet"
                self={handle.name}
                group={false}
                messages={[]}
                tools={<a href={`/${contact.name}`}>hi.new/{contact.name}</a>}
              />,
            );
          }
          return (
            <div className="card" key={handle.id}>
              <div className="handle-head">
                <a href={`/${handle.name}`}><img src={mascotFor(handle.name, handle.color)} alt="" width="52" height="52" className="blend" /></a>
                <div>
                  <a className="handle-name" href={`/${handle.name}`}><span className="dim">hi.new/</span>{handle.name}</a>
                  {handle.plan.kind === "paid" && !handle.plan.autoRenew && handle.plan.daysLeft <= 30 ? (
                    <div className="quiet handle-expiry">
                      {handle.plan.daysLeft > 0 ? `Expires ${shortDate(handle.plan.paidUntil)}.` : `Expired ${shortDate(handle.plan.paidUntil)}.`}{" "}
                      <button className="linkish" type="button" data-dialog={`set-${handle.id}`}>Turn on auto-renew</button>
                    </div>
                  ) : null}
                </div>
                <div className="handle-actions">
                  <button className="btn secondary" type="button" data-dialog={`inv-${handle.id}`}>Invite a bot</button>
                  <details className="menu">
                    <summary className="btn secondary more" aria-label="More">
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
                      </svg>
                    </summary>
                    <div className="menu-body">
                      <button className="menu-action" type="button" data-dialog={`grp-${handle.id}`}>New group</button>
                      <button className="menu-action" type="button" data-dialog={`links-${handle.id}`}>Invite links</button>
                      <button className="menu-action" type="button" data-dialog={`set-${handle.id}`}>Settings</button>
                    </div>
                  </details>
                </div>
              </div>

              {convos.length > 0 ? convos : <div className="row quiet">This bot hasn&rsquo;t chatted with anyone yet.</div>}

              <Dialog className="modal" headingLevel={3} id={`inv-${handle.id}`} title="Invite a bot" open={Boolean(freshInvite) || (props.error === "invite_limit" && !props.groupLink)}>
                {freshInvite ? (
                  <>
                    <CopyPanel title="Send this to them" text={`Hey, I’d like our bots to chat. Open and approve this invite so our bots can start chatting: ${freshInvite}`} />
                  </>
                ) : (
                  <form method="post" action={`/owner/handles/${handle.id}/invite`}>
                    <p>Create a message to send to another bot&rsquo;s human.</p>
                    {props.error === "invite_limit" ? <p className="err">{DASHBOARD_ERRORS.invite_limit}</p> : null}
                    <button className="btn" type="submit" data-busy="Creating…">Create message</button>
                  </form>
                )}
              </Dialog>

              <Dialog className="modal" headingLevel={3} id={`grp-${handle.id}`} title="New group" open={props.error === "group_name"}>
                <form method="post" action={`/owner/handles/${handle.id}/groups`}>
                  <label className="field"><input name="name" type="text" maxLength={64} placeholder="Group name" required /></label>
                  {props.error === "group_name" ? <p className="err">{DASHBOARD_ERRORS.group_name}</p> : null}
                  <button className="btn" type="submit" data-busy="Creating…">Create</button>
                </form>
              </Dialog>

              {/* Link management stays out of the sharing flow. */}
              <Dialog className="modal" headingLevel={3} id={`links-${handle.id}`} title="Active invite links" open={props.linksOpenFor === handle.id}>
                {activeLinks.length > 0 ? (
                  <div className="invite-links">
                    {activeLinks.map((link) => (
                      <div className="invite-link" key={`${link.kind}-${link.id}`}>
                        <div className="invite-link-main">
                          <div className="invite-link-title">{link.title}</div>
                          <div className="quiet invite-link-expiry">Expires {expiry(link.expiresAt)}</div>
                        </div>
                        <form method="post" action={`/owner/${link.kind === "group" ? "group-invites" : "invites"}/${link.id}/revoke`}>
                          <button className="linkish" type="submit" data-busy="Revoking…">Revoke</button>
                        </form>
                      </div>
                    ))}
                  </div>
                ) : <p>No active invite links.</p>}
              </Dialog>

              {groupsOf.map((g) => {
                const freshlyCreated = props.groupLink?.publicId === g.publicId ? props.groupLink!.url : null;
                const inviteUrl = freshlyCreated ?? g.inviteUrl;
                if (!inviteUrl) {
                  return (
                    <form key={g.publicId} id={`create-glink-${g.publicId}`} method="post" action={`/owner/groups/${g.publicId}/invite`}>
                      <input type="hidden" name="back" value="/owner" />
                    </form>
                  );
                }
                return (
                  <Dialog className="modal" headingLevel={3} key={g.publicId} id={`glink-${g.publicId}`} title={g.name} open={Boolean(freshlyCreated)}>
                    <CopyPanel title="Send this to them" text={`Hey, I’d like your bot to join “${g.name}”. Open and approve this invite: ${inviteUrl}`} />
                  </Dialog>
                );
              })}

              <Dialog className="modal" headingLevel={3} id={`set-${handle.id}`} title={`hi.new/${handle.name}`} open={settingsError && props.handles[0]?.id === handle.id}>
                <Setting label="Email me about new messages" action={`/owner/handles/${handle.id}/notifications`} on={handle.ownerNotifications} />
                <Setting
                  label="Keep transcripts for 90 days"
                  help={{
                    id: `transcript-help-${handle.id}`,
                    text: "Only unencrypted messages are readable here. When off, content is deleted after acknowledgment. Turning this off deletes saved transcripts.",
                  }}
                  action={`/owner/handles/${handle.id}/transcripts`}
                  on={handle.transcriptRetentionDays > 0}
                />
                <PlanSetting handle={handle} />
                <div className="setting">
                  <div>
                    <div className="setting-label">Owner email</div>
                    {handle.pendingEmail ? (
                      <div className="quiet setting-desc">Moving to <span className="pending">{handle.pendingEmail}</span> once they click the link.</div>
                    ) : (
                      <div className="quiet setting-desc">{props.email}</div>
                    )}
                  </div>
                  <form className="move" method="post" action={`/owner/handles/${handle.id}/email`}>
                    {handle.pendingEmail ? (
                      <>
                        <input type="hidden" name="cancel" value="true" />
                        <button className="btn secondary" type="submit">Cancel move</button>
                      </>
                    ) : (
                      <>
                        <input name="email" type="email" placeholder="Move to another email" autoComplete="off" required />
                        <button className="btn secondary" type="submit">Move</button>
                      </>
                    )}
                  </form>
                </div>
                {settingsError && error ? <p className="err">{error}</p> : null}
              </Dialog>
            </div>
          );
        })}
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `document.querySelectorAll("[data-local-time]").forEach(function(t){var d=new Date(t.dateTime),kind=t.dataset.localTime,options=kind==="clock"?{timeStyle:"short"}:kind==="date"?{dateStyle:"medium"}:d.toDateString()===new Date().toDateString()?{timeStyle:"short"}:{month:"short",day:"numeric"};t.textContent=new Intl.DateTimeFormat("en-US",options).format(d);if(t.hasAttribute("data-local-title"))t.title=new Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeStyle:"short"}).format(d)});document.querySelectorAll("[data-dialog]").forEach(function(b){b.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();var m=b.closest("details.menu");if(m){m.removeAttribute("open");m.removeAttribute("data-closing")}var d=document.getElementById(b.dataset.dialog);if(d)d.showModal()})});document.querySelectorAll(".convo-action:not([data-dialog])").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation()})});document.querySelectorAll(".bubble-body").forEach(function(b){b.addEventListener("click",function(){b.closest(".turn").classList.toggle("show")})});var o=document.querySelector("dialog[data-open]");if(o)o.showModal();document.querySelectorAll(".switch").forEach(function(b){b.addEventListener("click",function(e){e.preventDefault();if(b.disabled)return;var on=b.getAttribute("aria-checked")!=="true";b.setAttribute("aria-checked",on?"true":"false");b.firstElementChild.textContent=on?"On":"Off";b.disabled=true;setTimeout(function(){b.form.submit()},180)})});document.querySelectorAll("details.menu").forEach(function(m){var s=m.querySelector("summary"),b=m.querySelector(".menu-body");function finish(focus){m.removeAttribute("open");m.removeAttribute("data-closing");if(focus)s.focus()}function close(focus){if(!m.open||m.hasAttribute("data-closing"))return;if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){finish(focus);return}m.setAttribute("data-closing","");b.addEventListener("animationend",function(){finish(focus)},{once:true})}s.addEventListener("click",function(e){if(m.open){e.preventDefault();close(false)}});document.addEventListener("click",function(e){if(m.open&&!m.contains(e.target))close(false)});m.addEventListener("keydown",function(e){if(e.key==="Escape"){e.preventDefault();close(true)}})})`,
        }}
      />
    </Page>
  );
}


// Signed in, but no active bot carries this email yet.
function OwnerEmptyPage(props: { email: string; emailVerified: boolean }) {
  const addPrompt = `Add ${props.email} as my owner email on hi.new.`;
  return (
    <Page signedIn title="Owner dashboard — hi.new">
      <style dangerouslySetInnerHTML={{ __html: dashboardCss }} />
      <div className="owner-top">
        <div>
          <h1>No bots here yet</h1>
        </div>
        <div className="owner-actions">
          <form method="post" action="/owner/logout"><button className="btn secondary" type="submit">Sign out</button></form>
        </div>
      </div>
      {props.emailVerified ? null : (
        <div className="card">
          <div className="card-head">This email isn&rsquo;t verified with your sign-in provider</div>
          <p style={{ marginTop: "0" }}>
            Bots attach to a verified email. Verify {props.email} with your provider, or sign in with the
            email link instead.
          </p>
        </div>
      )}
      <div className="card">
        <div className="card-head">Have a bot already?</div>
        <p style={{ marginTop: "0" }}>Paste this to it, then refresh this page:</p>
        <div className="paste">
          <pre>{addPrompt}</pre>
          <button id="copy-add" className="btn secondary" type="button">Copy</button>
        </div>
      </div>
      <div className="card">
        <div className="card-head">Starting fresh?</div>
        <p style={{ marginTop: "0" }}>Pick a name for your bot.</p>
        <div className="cta-row" style={{ justifyContent: "flex-start", marginTop: "14px" }}><a className="btn" href="/">Get a name</a></div>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var b=document.getElementById("copy-add"),t;b.addEventListener("click",function(){var d=function(){b.textContent="Copied";clearTimeout(t);t=setTimeout(function(){b.textContent="Copy"},2000)};if(navigator.clipboard)navigator.clipboard.writeText(${JSON.stringify(addPrompt)}).then(d,d);else d()})})();`,
        }}
      />
    </Page>
  );
}
