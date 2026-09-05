import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  BOT_COLORS,
  BotCard,
  COLOR_HEX,
  defaultColorFor,
  GitHubIcon,
  GoogleIcon,
  Headline,
  isBotColor,
  MailIcon,
  shareOnXUrl,
  setupCodePrompt,
  setupTokenPrompt,
  StepFooter,
  XIcon,
  type BotColor,
} from "@hi-new/ui";
import { markClaimActive, readClaim } from "../lib/claim";
import { track } from "@hi-new/ui/analytics";
import LiveHome from "./LiveHome";

type Session = {
  name: string;
  token: string;
  color: BotColor;
  price?: number;
};

type EmailState = { status: "todo" | "sent" | "verified"; address: string };
type Providers = { github: boolean; google: boolean };

function SignInChoice(props: {
  icon: ReactNode;
  label: string;
  provider?: "github" | "google";
  next?: string;
  onClick?: () => void;
}) {
  const button = (
    <button className="btn btn-secondary provider" type={props.provider ? "submit" : "button"} onClick={props.onClick}>
      {props.icon} {props.label}
    </button>
  );
  return (
    <div className="provider-slot">
      {props.provider ? (
        <form method="post" action={`/owner/login/${props.provider}`}>
          <input type="hidden" name="next" value={props.next ?? "/owner"} />
          {button}
        </form>
      ) : button}
    </div>
  );
}

function EmailRecoveryFields(props: {
  email: EmailState;
  error: string;
  sending: boolean;
  providers?: Providers;
  next?: string;
  onAddressChange: (address: string) => void;
  onSend: () => void;
}) {
  const [useEmail, setUseEmail] = useState(false);
  if (props.email.status !== "todo") {
    return (
      <p className="done-line">
        {props.email.status === "verified" ? "Signed in. This name is yours to keep." : "Link sent. Check your email to finish."}
      </p>
    );
  }
  const social = Boolean(props.providers && (props.providers.github || props.providers.google));
  if (social && !useEmail) {
    return (
      <div className="providers">
        {props.providers!.github && <SignInChoice icon={<GitHubIcon />} label="GitHub" provider="github" next={props.next} />}
        {props.providers!.google && <SignInChoice icon={<GoogleIcon />} label="Google" provider="google" next={props.next} />}
        <SignInChoice icon={<MailIcon />} label="Email" onClick={() => setUseEmail(true)} />
      </div>
    );
  }
  return (
    <>
      <div className="token-row">
        <input
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          autoFocus={useEmail}
          value={props.email.address}
          onChange={(event) => props.onAddressChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") props.onSend(); }}
        />
        <button className="btn" onClick={props.onSend} disabled={props.sending}>
          {props.sending ? "Sending…" : "Send link"}
        </button>
      </div>
      {props.error && <div className="quiet-note status">{props.error}</div>}
      {social && (
        <div className="providers-alt">
          <button className="text-action" type="button" onClick={() => setUseEmail(false)}>Sign in with GitHub or Google instead</button>
        </div>
      )}
    </>
  );
}

const MIN_CODE_LIFE_MS = 5 * 60_000;

function grokBotLink(): string {
  return "grokbot://app/v1/open";
}
const desktop = typeof navigator !== "undefined" && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export default function SetupFlow() {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<"flow" | "checking" | "unpaid" | "activating">("flow");
  const [payErr, setPayErr] = useState("");
  const [paying, setPaying] = useState(false);
  const [screen, setScreen] = useState<"boot" | "ceremony" | "paste" | "email" | "live">("boot");
  const [email, setEmail] = useState<EmailState>({ status: "todo", address: "" });
  const [providers, setProviders] = useState<Providers>({ github: false, google: false });
  const [emailError, setEmailError] = useState("");
  const [sending, setSending] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const [everCopied, setEverCopied] = useState(false);
  const [openedGrokBot, setOpenedGrokBot] = useState(false);

  const code = useRef<{ value: string; expires: number } | null>(null);
  const codeRefresh = useRef<Promise<void> | null>(null);
  const [refreshingCode, setRefreshingCode] = useState(false);
  const invitedBy = useRef<{ token: string; from: string } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The whole flow is URL-driven: bare = ceremony, ?step=paste|email|live.
  // Back and forward walk it like any pages.
  type Step = "paste" | "email" | "live";
  const applyStep = (step: Step | null) => setScreen(step ?? "ceremony");
  const readStep = (): Step | null => {
    const s = new URLSearchParams(location.search).get("step");
    return s === "paste" || s === "email" || s === "live" ? s : null;
  };
  const goStep = (step: Step | null) => {
    history.pushState(null, "", location.pathname + (step ? "?step=" + step : ""));
    applyStep(step);
  };

  const auth = (token: string) => ({ authorization: "Bearer " + token });
  const buildPrompt = (name: string, token: string) => {
    const fresh = code.current && Date.now() < code.current.expires;
    return fresh
      ? setupCodePrompt(location.origin, name, code.current!.value, invitedBy.current)
      : setupTokenPrompt(location.origin, name, token, invitedBy.current);
  };

  // The prompt carries a one-time setup code the bot trades for the token,
  // so the transcript only ever holds a credential that dies in 15 minutes.
  function refreshCode(s: Session): Promise<void> {
    if (codeRefresh.current) return codeRefresh.current;
    setRefreshingCode(true);
    codeRefresh.current = (async () => {
      try {
        const res = await fetch("/api/handles/me/setup-code", { method: "POST", headers: auth(s.token) });
        if (res.ok) {
          const data = await res.json();
          code.current = { value: data.code, expires: Date.parse(data.expires_at) };
        }
      } catch { /* keep the saved token available when code minting is unavailable */ }
      setPrompt(buildPrompt(s.name, s.token));
    })().finally(() => {
      codeRefresh.current = null;
      setRefreshingCode(false);
    });
    return codeRefresh.current;
  }

  useEffect(() => {
    const claim = readClaim();
    // Served at /:name/setup (and plain /setup). A path that names a bot this
    // tab didn't claim goes to that bot's profile instead.
    const pathName = location.pathname.match(/^\/([a-z0-9][a-z0-9_-]*)\/setup\/?$/i)?.[1]?.toLowerCase() ?? null;
    const paidReturn = new URLSearchParams(location.search).get("paid") === "1";
    const name = pathName ?? claim?.name ?? null;
    if (!name) return void location.replace("/");
    const token = claim && claim.name === name ? claim.token : null;
    if (!token) return void location.replace("/" + name);
    if (claim?.link && claim.from) invitedBy.current = { token: claim.link, from: claim.from };
    const s: Session = {
      name,
      token: token ?? "",
      color: isBotColor(claim?.color) ? claim!.color : defaultColorFor(name),
      price: claim?.price_usd_per_year,
    };
    setSession(s);

    const start = () => {
      // The ceremony plays once per name — tracked explicitly, so a reload
      // resumes at the paste step but a fresh claim always gets its moment.
      let seen = false;
      try { seen = sessionStorage.getItem("hi_setup_seen:" + name) === "1"; } catch {}
      const step = readStep() ?? (seen ? "paste" : null);
      history.replaceState(null, "", "/" + name + "/setup" + (step ? "?step=" + step : ""));
      applyStep(step);
      refreshCode(s);
      // Repaint from the saved profile and pick up an already-attached email
      // (signed-in owners get one at claim time). A verified owner session
      // with no email on the handle yet (back from GitHub/Google) attaches it.
      (async () => {
        try {
          const [res, who] = await Promise.all([
            fetch("/api/handles/me", { headers: auth(s.token), cache: "no-store" }),
            fetch("/api/owner/session", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          ]);
          if (who?.providers) setProviders(who.providers);
          if (res.ok) {
            const me = await res.json();
            if (isBotColor(me.color)) setSession((prev) => (prev ? { ...prev, color: me.color } : prev));
            if (me.email) setEmail({ status: me.email_verified === true ? "verified" : "sent", address: me.email });
            else if (who?.signed_in && who.email) {
              const attach = await fetch("/api/handles/me/owner", { method: "POST", credentials: "same-origin", headers: auth(s.token) });
              if (attach.ok) {
                setEmail({ status: "verified", address: who.email });
                // Back from GitHub/Google with the name now attached: nothing
                // is left to do on the email step, so go straight on.
                if (step === "email") {
                  history.replaceState(null, "", "/" + name + "/setup?step=live");
                  applyStep("live");
                }
              }
            }
          }
        } catch {}
      })();
    };

    // The saved claim can outlive the payment redirect. OAuth also returns
    // without ?paid=1, so ask the authenticated endpoint before showing the
    // reservation as unpaid again.
    if (claim?.paid && !paidReturn) {
      setMode("checking");
      void (async () => {
        try {
          const res = await fetch("/api/handles/me", { headers: auth(token!), cache: "no-store" });
          if (res.ok) {
            markClaimActive(name);
            setMode("flow");
            start();
            return;
          }
        } catch { /* fall through to the saved reservation */ }
        history.replaceState(null, "", "/" + name + "/setup");
        setMode("unpaid");
      })();
      return;
    }

    if (!paidReturn) return void start();

    // Back from Stripe: the webhook may not have landed yet, so poll the
    // authenticated profile until this claimant's name reports active.
    setMode("activating");
    history.replaceState(null, "", "/" + name + "/setup");
    const began = Date.now();
    const tick = async () => {
      try {
        const res = await fetch("/api/handles/me", { headers: auth(token), cache: "no-store" });
        if (res.status === 200) {
          const profile = await res.json();
          markClaimActive(name);
          if (isBotColor(claim?.color) && claim!.color !== profile.color) {
            fetch("/api/handles/me", {
              method: "PATCH",
              headers: { "content-type": "application/json", ...auth(token) },
              body: JSON.stringify({ color: claim!.color }),
            }).catch(() => {});
          }
          setMode("flow");
          return void start();
        }
      } catch { /* keep polling */ }
      if (Date.now() - began < 90_000) setTimeout(tick, 1500);
      else setPayErr("Activation is taking longer than usual. Refresh in a minute.");
    };
    tick();
  }, []);

  useEffect(() => {
    const onPop = () => applyStep(readStep());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (session && mode === "flow" && screen !== "boot") {
      track("setup_step_viewed", { source: "setup", step: screen });
    }
  }, [session?.name, mode, screen]);

  if (!session) return null;
  const { name, token, color } = session;
  const inSteps = screen === "paste" || screen === "email";
  const handedOff = everCopied && (!desktop || openedGrokBot);
  const live = screen === "live";
  const hero = screen === "boot" || screen === "ceremony";

  const pickColor = (c: BotColor) => {
    setSession({ ...session, color: c });
    if (mode === "unpaid") {
      try {
        const raw = sessionStorage.getItem("hi_claim");
        if (raw) {
          const cl = JSON.parse(raw);
          cl.color = c;
          sessionStorage.setItem("hi_claim", JSON.stringify(cl));
        }
      } catch {}
      return;
    }
    fetch("/api/handles/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...auth(token) },
      body: JSON.stringify({ color: c }),
    }).catch(() => {});
  };

  const payNow = async () => {
    setPaying(true);
    setPayErr("");
    try {
      const res = await fetch("/buy/" + encodeURIComponent(name) + "/checkout", {
        method: "POST",
        headers: { accept: "application/json", "x-hi-new-claim-token": token },
      });
      const data = await res.json();
      if (res.ok && data.url) {
        track("checkout_started", { source: "setup" });
        return void (location.href = data.url);
      }
      if (data.error === "name_taken") {
        const me = await fetch("/api/handles/me", { headers: auth(token), cache: "no-store" }).catch(() => null);
        if (me?.ok) {
          markClaimActive(name);
          location.reload();
          return;
        }
        setPayErr(`hi.new/${name} is already active.`);
      } else {
        setPayErr(data.hint || "Checkout isn't available right now.");
      }
    } catch {
      setPayErr("Network error. Try again.");
    }
    setPaying(false);
  };

  const copyPrompt = async () => {
    const fresh = code.current && Date.now() < code.current.expires - MIN_CODE_LIFE_MS;
    if (!fresh) await refreshCode(session);
    navigator.clipboard?.writeText(buildPrompt(name, token))
      .then(() => track("setup_prompt_copied", { source: "setup" })).catch(() => {});
    setCopied(true);
    setEverCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const next = () => goStep(email.status === "todo" ? "email" : "live");


  const sendEmail = async () => {
    const address = email.address.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
      setEmailError("That doesn't look like an email.");
      return;
    }
    setSending(true);
    setEmailError("");
    try {
      const res = await fetch("/api/handles/me", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ email: address }),
      });
      const data = await res.json();
      if (res.ok) {
        track("owner_email_requested", { source: "setup" });
        setEmail({ status: "sent", address });
        if (screen === "email") goStep("live");
      } else {
        setEmailError(data.hint || data.error || "Something went wrong.");
      }
    } catch {
      setEmailError("Network error. Try again.");
    }
    setSending(false);
  };

  return (
    <main className={"welcome" + (inSteps ? " setup" : "") + (live && mode === "flow" ? " live" : "")}>
      {mode === "unpaid" && (
        <Headline title="Almost yours." sub={<>hi.new/{name} is reserved for 24 hours. Pay to activate it, or pick a longer name for free.</>} />
      )}
      {mode === "checking" && <Headline title="Checking your name." sub={<>Confirming hi.new/{name}&hellip;</>} />}
      {mode === "activating" && <Headline title="Checking activation." sub={<>Confirming hi.new/{name}&hellip;</>} />}
      {mode === "flow" && hero && <Headline title={<>It&rsquo;s yours.</>} sub={<>Your bot&rsquo;s new address.</>} />}
      {mode === "flow" && live && <Headline title="Your bot is live." sub="Anyone you invite can reach it." />}

      <BotCard name={name} color={color} />

      {(mode === "unpaid" || (mode === "flow" && hero)) && (
      <div className="color-pick" role="radiogroup" aria-label="Bot color">
        {BOT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            className={"swatch" + (c === color ? " on" : "")}
            aria-checked={c === color}
            aria-label={c}
            style={{ "--swatch": COLOR_HEX[c] } as CSSProperties}
            onClick={() => pickColor(c)}
          ></button>
        ))}
      </div>
      )}

      {mode === "unpaid" && (
        <>
          <div className="claim-actions">
            <button className="btn" type="button" onClick={payNow} disabled={paying}>
              {paying ? "Taking you to checkout…" : `Pay $${session.price}/yr`}
            </button>
            <a className="btn btn-secondary" href="/#names">Pick a longer name for free</a>
          </div>
          {payErr && <p className="quiet-note">{payErr}</p>}
        </>
      )}
      {mode === "activating" && payErr && <p className="quiet-note">{payErr}</p>}

      {mode === "flow" && screen === "ceremony" && (
        <div className="setup-gate">
          <button
            className="btn btn-lg"
            type="button"
            onClick={() => {
              try { sessionStorage.setItem("hi_setup_seen:" + name, "1"); } catch {}
              goStep("paste");
            }}
          >Set up your bot</button>
          <a className="text-action x-link" href={shareOnXUrl(name)} target="_blank" rel="noopener"><XIcon /> Post it on X</a>
        </div>
      )}

      {screen === "paste" && (
        <section className="panel invite-panel" id="panel-bot">
          <div className="panel-head">
            <h2 className="panel-title">Send this to your bot</h2>
            <div className="head-actions">
              {desktop && everCopied && (
                <a
                  id="open-grokbot"
                  className={openedGrokBot ? "btn btn-secondary" : "btn"}
                  href={grokBotLink()}
                  onClick={() => setOpenedGrokBot(true)}
                >Open Grok Bot</a>
              )}
              <button id="copy-prompt" className={everCopied ? "btn btn-secondary" : "btn"} onClick={copyPrompt} disabled={refreshingCode}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
          {/* Selecting and copying by hand counts too. */}
          <pre id="bot-prompt" onCopy={() => setEverCopied(true)}>{prompt}</pre>
          <StepFooter
            onBack={() => goStep(null)}
            action={<button className={handedOff ? "btn" : "btn btn-secondary"} type="button" onClick={next}>Next</button>}
          />
        </section>
      )}

      {screen === "email" && (
        <section className="panel invite-panel" id="panel-email">
          <div className="panel-head">
            <h2 className="panel-title">Don&rsquo;t lose this name.</h2>
          </div>
          <p className="panel-sub">Sign in once and you can always get it back.</p>
          <EmailRecoveryFields
            email={email}
            error={emailError}
            sending={sending}
            providers={providers}
            next={"/" + name + "/setup?step=email"}
            onAddressChange={(address) => setEmail((current) => ({ ...current, address }))}
            onSend={sendEmail}
          />
          <StepFooter
            onBack={() => goStep("paste")}
            action={
              email.status === "todo" ? (
                <button className="btn btn-secondary" type="button" onClick={() => goStep("live")}>Skip for now</button>
              ) : (
                <button className="btn" type="button" onClick={() => goStep("live")}>Next</button>
              )
            }
          />
        </section>
      )}

      {live && (
        <LiveHome name={name} token={token} invitedBy={invitedBy.current?.from ?? null} onSetupPrompt={() => goStep("paste")} />
      )}
    </main>
  );
}
