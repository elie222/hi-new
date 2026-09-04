import tokensCss from "@hi-new/ui/tokens.css" with { type: "text" };
import { DIALOG_CSS, Footer, Nav, NAV_CSS, TILT_SCRIPT } from "@hi-new/ui";
import type { ReactNode } from "react";

// The shared design tokens, then the product-page styles on top. The type
// and color system is the landing's.
const css = `${tokensCss}
:root {
  --iz-blue: #2563EB; --iz-radius: 8px; --iz-radius-md: 13px;
  --font-display: var(--iz-font-display);
  --font-body: "Geist", -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: var(--iz-font-mono);
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--iz-page); color: var(--iz-body); font-family: var(--font-body);
  font-size: 16px; line-height: 1.5; -webkit-font-smoothing: antialiased;
  min-height: 100vh; display: flex; flex-direction: column;
}
main { max-width: 640px; width: 100%; margin: 0 auto; padding: 48px 24px; flex: 1; }
h1 { font-weight: 600; font-size: 34px; letter-spacing: -0.02em; color: var(--iz-ink); line-height: 1.1; }
p { color: var(--iz-muted); margin-top: 12px; }
a { color: var(--iz-blue); text-decoration: none; }
code, pre {
  font-family: var(--font-mono); font-size: 13.5px; background: var(--iz-surface);
  border: 1px solid var(--iz-line); border-radius: var(--iz-radius); color: var(--iz-ink);
}
code { padding: 1px 6px; }
pre { padding: 14px 16px; margin-top: 16px; overflow-x: auto; line-height: 1.6; }
.card { border: 1px solid var(--iz-line); border-radius: 16px; padding: 28px; margin-top: 20px; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,0.03); }
.card-head { font-weight: 600; font-size: 16px; color: var(--iz-ink); margin-bottom: 10px; }
.chip { display: inline-block; font-family: var(--font-mono); font-size: 12px; padding: 4px 12px; border-radius: 999px; background: var(--iz-surface); border: 1px solid var(--iz-line); color: var(--iz-muted); }
.chip.ok { color: var(--iz-green-600); background: #F3FFEF; border-color: #CFF4C0; }
.chip.blue { color: var(--iz-blue); background: #EFF6FF; border-color: #D6E8FC; }
.blend { mix-blend-mode: multiply; }
.faded { opacity: 0.45; filter: grayscale(0.4); }
.profile-card {
  text-align: center; padding: 38px 28px 30px; border-radius: 22px;
  background: linear-gradient(to bottom, #EFF6FF, #fff);
  border: 1px solid #D6E8FC; box-shadow: 0 10px 40px -10px rgba(0,0,0,0.10);
}
.profile-card.unclaimed { background: linear-gradient(to bottom, var(--iz-surface), #fff); border-color: var(--iz-line-2, #E6E6E6); }
.profile-card img { display: block; margin: 0 auto 12px; }
.profile-handle {
  font-weight: 700; font-size: clamp(26px, 5vw, 34px); letter-spacing: -0.02em; line-height: 1.15;
  color: var(--iz-ink); margin-bottom: 14px; word-break: break-all;
}
.profile-handle .dim { color: var(--iz-muted); }
.chips { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
.fingerprint { margin-top: 18px; }
.fp-label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--iz-muted); margin-bottom: 6px; text-transform: uppercase; }
.fingerprint code { font-size: 14px; }
.cta-row { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 24px; flex-wrap: wrap; }
.cta-row .btn { margin-top: 0; }
.quiet { font-size: 13.5px; color: var(--iz-muted); }
.howto { margin: 0; padding-left: 22px; color: var(--iz-body); }
.howto li { margin-top: 6px; }
.card-link { margin-top: 22px; text-align: left; }
.card-link .link-out { margin-top: 8px; }
.modal { margin: auto; border: 0; border-radius: 16px; padding: 20px 22px 22px; width: min(420px, calc(100vw - 32px)); box-shadow: 0 30px 80px -20px rgba(0,0,0,.35); color: var(--iz-body); text-align: left; }
.modal::backdrop { background: rgba(20, 30, 50, .4); }
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dialog-head h3 { font-weight: 600; font-size: 16px; color: var(--iz-ink); }
.dialog-head form { margin: 0; }
.dialog-close { border: 0; background: none; font-size: 22px; line-height: 1; color: var(--iz-muted); cursor: pointer; padding: 4px 6px; }
.dialog-close:hover { color: var(--iz-ink); }
.seg { display: flex; gap: 18px; margin-top: 14px; font-size: 14px; color: var(--iz-ink); }
.seg label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.field { display: block; margin-top: 12px; }
.field[hidden] { display: none; }
.field > span { display: block; font-size: 13px; font-weight: 500; color: var(--iz-ink); margin-bottom: 6px; }
.field input[type="text"], .field select, .field textarea {
  width: 100%; padding: 9px 12px; border: 1px solid var(--iz-line-2, #E6E6E6); border-radius: 8px;
  font-size: 14px; font-family: var(--font-body); color: var(--iz-body); background: #fff; }
.field textarea { min-height: 72px; resize: vertical; }
.choice { display: flex; gap: 10px; align-items: flex-start; margin-top: 10px; font-size: 14px; color: var(--iz-body); }
.choice input { margin-top: 3px; }
.choice .quiet { display: block; }
.link-out { display: flex; gap: 8px; align-items: center; margin-top: 12px; padding: 10px 12px; background: #EFF6FF; border: 1px solid #D6E8FC; border-radius: 10px; }
.link-out code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; background: none; border: 0; padding: 0; }
.link-out .btn { margin-top: 0; padding: 7px 13px; font-size: 13px; }
.share-row { display: flex; gap: 8px; margin-top: 10px; }
.share-row .btn { margin-top: 0; }
.btn.small { padding: 6px 12px; font-size: 13px; }
.invite-page { width: 100%; max-width: 560px; margin: 0 auto; text-align: center; }
.bot-link { color: var(--iz-blue); font-weight: 500; }
.bot-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.copy-panel { margin: 22px auto 0; max-width: 460px; padding: 18px 20px 20px; text-align: left; background: #fff; border: 1px solid var(--iz-line); border-radius: 14px; box-shadow: 0 2px 16px rgba(0,0,0,0.03); }
.copy-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.copy-panel-head h2 { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; color: var(--iz-ink); }
.copy-panel-head .btn { margin: 0; height: 32px; padding: 0 14px; font-size: 13px; min-width: 5.2em; }
.copy-panel-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-body); font-size: 14.5px; line-height: 1.55; color: var(--iz-ink); }
.copy-panel-note { margin-top: 10px; }
.modal .copy-panel { margin: 12px 0 0; max-width: none; padding: 14px 16px 16px; }
.share-stage { perspective: 1100px; animation: card-in .55s cubic-bezier(.3,1.25,.44,1) both; }
.share-card {
  position: relative; padding: 34px 30px 30px; border-radius: 26px; text-align: center;
  background: linear-gradient(to bottom, color-mix(in srgb, var(--bot, #3E62E4) 11%, #fff), #fff);
  border: 1px solid color-mix(in srgb, var(--bot, #3E62E4) 26%, #fff);
  box-shadow: 0 14px 44px -14px color-mix(in srgb, var(--bot, #3E62E4) 28%, transparent);
  transform: rotateX(0) rotateY(0); will-change: transform; transition: box-shadow 220ms ease;
}
.share-card.is-lifted { box-shadow: 0 30px 70px -18px color-mix(in srgb, var(--bot, #3E62E4) 40%, transparent), 0 4px 14px -6px rgba(20,40,90,.08); }
.share-brand { margin-bottom: 14px; }
.share-brand span { font-family: var(--font-display); font-weight: 700; font-size: 18px; letter-spacing: -.02em; color: var(--iz-ink); }
.share-brand .share-dot { color: var(--iz-blue); }
.share-mascot { display: block; margin: 0 auto 12px; }
.share-handle { font-family: var(--font-display); font-weight: 700; font-size: clamp(26px,5vw,34px); letter-spacing: -.02em; line-height: 1.15; color: var(--iz-ink); overflow-wrap: anywhere; }
.share-handle .dim { color: #6D6E70; font-weight: 500; }
.connection-stage {
  display: grid; grid-template-columns: minmax(0,1fr) minmax(76px,96px) minmax(0,1fr);
  align-items: center; padding: 34px 28px 30px; border: 1px solid var(--iz-line);
  border-radius: 26px; background: #fff; box-shadow: 0 14px 44px -14px rgba(0,0,0,.12);
  animation: card-in .55s cubic-bezier(.3,1.25,.44,1) both;
}
.connection-bot { display: flex; flex-direction: column; align-items: center; min-width: 0; }
.connection-bot img { display: block; margin: 8px auto 12px; }
.connection-placeholder { position: relative; width: 104px; height: 124px; }
.connection-placeholder img { opacity: .24; filter: grayscale(1); }
.connection-label { color: var(--iz-muted); font-size: 12px; font-weight: 600; }
.connection-handle, .connection-picker {
  width: min(100%, 190px); min-width: 0; height: 34px; padding: 6px 10px;
  border: 1px solid var(--iz-line-2, #E6E6E6); border-radius: 999px;
  background: var(--iz-surface); color: var(--iz-ink); font-family: var(--font-mono);
  font-size: 12px; line-height: 20px; text-align: center; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.connection-picker {
  /* The native caret hugs the element edge and collides with the pill radius,
     so draw our own and inset it. */
  appearance: none; -webkit-appearance: none;
  padding-right: 32px; cursor: pointer; text-align: left;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1.25 5 5l4-3.75' stroke='%23848484' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 13px center; background-size: 10px 6px;
}
.connection-picker::-ms-expand { display: none; }
.connection-new { color: var(--iz-muted); font-family: var(--font-body); font-weight: 500; }
.connection-wire { position: relative; height: 1px; margin-top: 20px; }
.connection-dashed { width: 100%; height: 1px; background: repeating-linear-gradient(to right, #D9DDE5 0 6px, transparent 6px 12px); }
.connection-plus {
  position: absolute; left: 50%; top: 50%; width: 28px; height: 28px; transform: translate(-50%,-50%);
  display: grid; place-items: center; border: 1px solid #D6E8FC; border-radius: 999px;
  background: #EFF6FF; color: var(--iz-blue); font-size: 20px; font-weight: 500; line-height: 1;
}
.invite-content { padding: 30px 16px 0; animation: content-in .35s ease-out .1s both; }
.invite-kicker { color: var(--iz-blue); font-size: 12px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.invite-kicker.success { color: var(--iz-green-600); }
.invite-title { text-align: center; font-family: var(--font-display); font-size: clamp(28px,5vw,34px); font-weight: 500; color: var(--iz-ink); margin-top: 8px; }
.invite-content > .invite-title:first-child { margin-top: 0; }
.share-stage + .invite-title { margin-top: 28px; }
.invite-copy { margin: 10px auto 0; max-width: 390px; font-size: 16px; color: var(--iz-muted); }
.invite-actions { display: flex; flex-direction: column; align-items: center; gap: 14px; margin-top: 22px; }
.invite-content > .invite-actions:first-child { margin-top: 0; }
.invite-actions .btn { margin-top: 0; }
.invite-actions .field { width: min(320px, 100%); }
.text-action {
  margin-top: 18px; padding: 4px 8px; border: 0; background: none; color: var(--iz-muted);
  font-family: var(--font-body); font-size: 13.5px; font-weight: 600; text-decoration: none; cursor: pointer;
}
.text-action:hover { color: var(--iz-blue); text-decoration: underline; text-underline-offset: 3px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.empty-state { max-width: 440px; margin: 72px auto; padding: 28px; text-align: center; background: #fff; border: 1px solid var(--iz-line); border-radius: 16px; box-shadow: 0 2px 16px rgba(0,0,0,.03); }
.err-text { color: #C94244; font-size: 13.5px; margin-top: 10px; }
.said { max-width: 390px; margin: 18px auto 0; padding: 12px 14px; border-radius: 10px; background: var(--iz-surface); color: var(--iz-body); font-style: italic; text-align: left; }
.paste { display: flex; align-items: flex-start; gap: 10px; margin-top: 14px; }
.paste pre { flex: 1; min-width: 0; margin-top: 0; padding: 10px 12px; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--iz-body); }
.paste .btn { margin-top: 0; flex-shrink: 0; }
.btn { display: inline-block; margin-top: 20px; padding: 10px 22px; border-radius: var(--iz-radius-md); border: 0; cursor: pointer;
  background: linear-gradient(#2965EC, #5C89F8); color: #fff; font-family: var(--font-body); font-size: 15px; font-weight: 500;
  box-shadow: 0 2px 10.1px rgba(75,131,253,0.2); }
.btn.busy { opacity: .7; cursor: progress; }
.btn.busy::before { content: ""; display: inline-block; width: 12px; height: 12px; margin-right: 8px; vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes card-in { from { opacity: 0; transform: scale(.94) translateY(10px) } to { opacity: 1; transform: none } }
@keyframes content-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.btn.secondary { background: #fff; color: var(--iz-ink); border: 1px solid var(--iz-line-2, #E6E6E6); box-shadow: var(--iz-shadow, 0 2px 16px rgba(0,0,0,0.03)); }
@media (prefers-reduced-motion: reduce) { .share-stage, .invite-content { animation: none; } .share-card { transition: none; } }
@media (max-width: 640px) {
  main { padding: 32px 20px 40px; }
  h1 { font-size: 30px; }
  .card { padding: 20px; }
  .profile-card { padding: 30px 18px 26px; }
  .share-card { padding: 28px 20px 26px; }
  .connection-stage { grid-template-columns: minmax(0,1fr) 52px minmax(0,1fr); padding: 26px 12px 24px; }
  .connection-bot img { width: 82px; height: 82px; margin: 8px auto 10px; }
  .connection-placeholder { width: 82px; height: 100px; }
  .connection-handle, .connection-picker { width: 100%; height: 32px; padding: 5px 8px; font-size: 10.5px; }
  .connection-picker { padding-right: 26px; background-position: right 10px center; }
  .connection-wire { margin: 16px 6px 0; }
  .connection-plus { width: 24px; height: 24px; font-size: 17px; }
  .invite-content { padding: 26px 0 0; }
  /* Break long handles at hyphens first, mid-word only as a last resort. */
  .profile-handle { word-break: normal; overflow-wrap: anywhere; }
  .paste { flex-direction: column; align-items: flex-start; }
  .paste pre { width: 100%; }
  .link-out { flex-wrap: wrap; }
  .link-out code { flex-basis: 100%; }
}
${DIALOG_CSS}
${NAV_CSS}`;

// Copy buttons confirm only after a successful clipboard write. The bot prompt
// opens for manual selection when both modern and legacy clipboard APIs fail.
const COPY_SCRIPT = `
document.querySelectorAll("form").forEach(function(form){
  if(form.getAttribute("method")==="dialog")return;
  form.addEventListener("submit",function(){
    var button=form.querySelector("button[type=submit]:not(.switch)");
    if(!button||button.classList.contains("busy"))return;
    button.classList.add("busy");
    button.setAttribute("aria-busy","true");
    button.dataset.label=button.textContent;
    button.textContent=button.dataset.busy||"Working…";
    setTimeout(function(){button.style.pointerEvents="none"},0);
  });
});
document.querySelectorAll("dialog.modal").forEach(function(dialog){
  dialog.addEventListener("click",function(event){
    var rect=dialog.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();
  });
});
function legacyCopy(value){
  var area=document.createElement("textarea");
  area.value=value;
  area.setAttribute("readonly","");
  area.style.position="fixed";
  area.style.left="-9999px";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0,area.value.length);
  var copied=false;
  try{copied=document.execCommand("copy")}catch(error){}
  area.remove();
  return copied;
}
function flashCopy(button,label){
  button.dataset.copyLabel=button.dataset.copyLabel||button.textContent;
  clearTimeout(button.copyTimer);
  button.textContent=label;
  button.setAttribute("aria-live","polite");
  button.copyTimer=setTimeout(function(){button.textContent=button.dataset.copyLabel},2000);
}
document.querySelectorAll("[data-copy]").forEach(function(button){
  button.addEventListener("click",function(){
    var value=button.dataset.copy||"";
    function done(){flashCopy(button,"Copied")}
    function fallback(){
      if(legacyCopy(value))done();
      else flashCopy(button,"Copy failed")
    }
    if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(value).then(done,fallback);
    else fallback();
  });
});
`;

const PAGE_SCRIPT = `${COPY_SCRIPT}\n${TILT_SCRIPT}`;

export function Page(props: {
  title: string;
  description?: string;
  signedIn?: boolean;
  markdownAlternate?: string;
  describedBy?: string;
  // Absolute URL of a page-specific share image (defaults to the site card).
  ogImage?: string;
  children: ReactNode;
}) {
  const ogImage = props.ogImage ?? "https://hi.new/og.png";
  const description =
    props.description ??
    "hi.new gives your bot an address. Encrypted bot-to-bot messages for AI agents, with ephemeral payloads and owner-visible delivery activity.";
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta name="description" content={description} />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {props.markdownAlternate ? <link rel="alternate" type="text/markdown" href={props.markdownAlternate} /> : null}
        {props.describedBy ? <link rel="describedby" type="text/markdown" href={props.describedBy} /> : null}
        <meta property="og:site_name" content="hi.new" />
        <meta property="og:title" content={props.title} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content={ogImage} />
        <meta name="twitter:card" content="summary_large_image" />
        {props.ogImage ? <meta name="twitter:image" content={ogImage} /> : null}
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <Nav signedIn={props.signedIn} />
        <main>{props.children}</main>
        <Footer />
        <script dangerouslySetInnerHTML={{ __html: PAGE_SCRIPT }} />
      </body>
    </html>
  );
}
