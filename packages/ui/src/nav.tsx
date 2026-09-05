// The one site nav and the product-page footer. Astro pages render them at
// build time; the Worker renders them per request. Same markup, typography,
// and responsive behavior everywhere.

export type NavLink = {
  href: string;
  label: string;
  /** Render as a button. */
  primary?: boolean;
  /** Drop on narrow screens. */
  hideOnMobile?: boolean;
};

export const FOR_BOTS: NavLink = { href: "/connect", label: "For bots" };

// Aeonik @font-face lives in tokens.css.
export const NAV_CSS = `
.site-nav .wordmark {
  display: inline-flex; align-items: baseline; text-decoration: none;
  font-family: var(--iz-font-display, "Aeonik", "Inter Tight", -apple-system, BlinkMacSystemFont, sans-serif);
  font-weight: 500; font-size: 22px; line-height: 1; letter-spacing: -0.02em;
  color: var(--iz-ink, #242424);
}
.site-nav .wordmark span { font: inherit; color: inherit; }
.site-nav .wordmark .dot { color: var(--iz-blue-brand, #2563EB); }
.site-nav {
  width: 100%; max-width: 1000px; margin: 0 auto; padding: 24px 28px;
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
}
.site-nav .wordmark { align-items: center; gap: 8px; }
.site-nav .wordmark-bot { width: 38px; height: 38px; flex: none; object-fit: contain; }
.site-nav .nav-links { display: flex; align-items: center; gap: 24px; }
.site-nav .nav-links a { font-size: 15px; color: #6D6E70; text-decoration: none; }
.site-nav .nav-links a:hover { color: var(--iz-blue-brand, #2563EB); }
.site-nav .nav-links a.btn {
  display: inline-flex; align-items: center; margin: 0; height: 38px; padding: 0 17px;
  border-radius: 13px; font-size: 14px; font-weight: 500; color: #fff;
  background: linear-gradient(#2965EC, #5C89F8); box-shadow: 0 2px 10.1px rgba(75, 131, 253, 0.2);
}
.site-nav .nav-links a.btn:hover { color: #fff; filter: brightness(1.05); }
.site-footer {
  width: 100%; max-width: 1000px; margin: 0 auto; padding: 28px 28px 34px;
  display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;
  font-size: 14px; color: var(--iz-muted, #848484);
}
.site-footer .footer-links { display: flex; gap: 12px 24px; flex-wrap: wrap; }
.site-footer .footer-links a, .site-footer .tagline { color: var(--iz-muted-2, #6D6E70); text-decoration: none; }
.site-footer .footer-links a:hover, .site-footer .tagline:hover { color: var(--iz-blue-brand, #2563EB); }
.site-footer .tagline { font-size: 13px; }
@media (max-width: 640px) {
  .site-footer { justify-content: center; text-align: center; padding: 24px 20px 30px; }
  .site-footer .footer-links { order: 3; width: 100%; justify-content: center; }
  .site-nav { padding: 20px 20px; }
  .site-nav .wordmark { gap: 6px; font-size: 20px; }
  .site-nav .wordmark-bot { width: 34px; height: 34px; }
  .site-nav .nav-links { gap: 14px; }
  .site-nav .nav-hide-sm { display: none; }
}
`;

// Static pages (the Astro landing) can't see the owner session, so they leave
// `signedIn` undefined and this script asks the API after load. Server-rendered
// pages pass a boolean and skip it.
const OWNER_LINK_SCRIPT =
  `(function(){function refresh(){fetch("/api/owner/session",{cache:"no-store",credentials:"same-origin"})` +
  `.then(function(r){return r.ok?r.json():null})` +
  `.then(function(d){if(!d)return;document.querySelectorAll("[data-owner-link]").forEach(function(a){a.textContent=d.signed_in?"Dashboard":"Sign in"})})` +
  `.catch(function(){})}refresh();addEventListener("pageshow",function(e){if(e.persisted)refresh()})})()`;

export function Nav(props: { links?: NavLink[]; signedIn?: boolean }) {
  const known = typeof props.signedIn === "boolean";
  const ownerLink: NavLink & { owner: true } = { href: "/owner", label: props.signedIn ? "Dashboard" : "Sign in", owner: true };
  const links: (NavLink & { owner?: true })[] = [...(props.links ?? [FOR_BOTS]), ownerLink];
  return (
    <>
      <nav className="site-nav">
        <a className="wordmark" href="/" aria-label="hi.new home">
          <img className="wordmark-bot" src="/img/bot-mia-blue-envelope-facing-right-balanced-transparent-v5-76.png" alt="" width="38" height="38" />
          <span className="wordmark-text"><span>hi</span><span className="dot">.new</span></span>
        </a>
        <div className="nav-links">
          {links.map((l) => {
            const cls = [l.primary && "btn", l.hideOnMobile && "nav-hide-sm"].filter(Boolean).join(" ");
            return (
              <a key={l.href} href={l.href} className={cls || undefined} data-owner-link={l.owner ? "" : undefined}>
                {l.label}
              </a>
            );
          })}
        </div>
      </nav>
      {known ? null : <script dangerouslySetInnerHTML={{ __html: OWNER_LINK_SCRIPT }} />}
    </>
  );
}

// Shared footer for both the static landing pages and server-rendered product
// pages. Every variant starts with the core links below.
const FOOTER_LINKS: NavLink[] = [
  { href: "/connect", label: "Connect" },
  { href: "/skill.md", label: "API" },
  { href: "mailto:elie@getinboxzero.com", label: "Support" },
];

const DEFAULT_FOOTER_LINKS: NavLink[] = [
  { href: "https://github.com/elie222/hi-new", label: "GitHub" },
];

export function Footer(props: {
  links?: NavLink[];
  showWordmark?: boolean;
  className?: string;
} = {}) {
  const links = [...FOOTER_LINKS, ...(props.links ?? DEFAULT_FOOTER_LINKS)];
  return (
    <footer className={props.className ?? "site-footer"}>
      {props.showWordmark ? (
        <a className="wordmark sm" href="/"><span>hi</span><span className="dot">.new</span></a>
      ) : null}
      <div className="footer-links">
        {links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
      </div>
      <a className="tagline" href="https://www.getinboxzero.com">© 2026 Inbox Zero Inc.</a>
    </footer>
  );
}
