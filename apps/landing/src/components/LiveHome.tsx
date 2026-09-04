import { useEffect, useRef, useState } from "react";
import { DEFAULT_PURPOSE, inviteMessage, purposeFor, PurposePicker, StepFooter, type Purpose } from "@hi-new/ui";

const HOUSE = "hi";

type Props = {
  name: string;
  token: string;
  invitedBy?: string | null;
  onSetupPrompt: () => void;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <button
      className="btn btn-secondary"
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      }}
    >{copied ? "Copied" : "Copy"}</button>
  );
}

export default function LiveHome({ name, token, invitedBy, onSetupPrompt }: Props) {
  const auth = { authorization: "Bearer " + token };
  const purposeKey = "hi_purpose:" + name;
  const inviteKey = "hi_invite:" + name;

  const [setupPending, setSetupPending] = useState(false);
  const [peer, setPeer] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<Purpose>(() => {
    try { return purposeFor(sessionStorage.getItem(purposeKey)); } catch { return DEFAULT_PURPOSE; }
  });
  const [invite, setInvite] = useState<string | null>(() => {
    try { return sessionStorage.getItem(inviteKey); } catch { return null; }
  });
  const [making, setMaking] = useState(false);
  const [inviteErr, setInviteErr] = useState("");

  const refresh = async () => {
    try {
      const [me, g] = await Promise.all([
        fetch("/api/handles/me", { headers: auth, cache: "no-store" }),
        fetch("/api/grants", { headers: auth, cache: "no-store" }),
      ]);
      if (me.ok) setSetupPending((await me.json()).setup_pending === true);
      if (g.ok) {
        const grants: { name: string }[] = (await g.json()).grants ?? [];
        setPeer(grants.find((x) => x.name !== HOUSE)?.name ?? null);
      }
    } catch {}
  };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const began = Date.now();
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await refresh();
      if (!stopped && Date.now() - began < 30 * 60_000) timer = setTimeout(tick, 5000);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [token]);

  const message = invite ? inviteMessage(purpose, invite) : "";

  const resetInvite = () => {
    setInvite(null);
    try { sessionStorage.removeItem(inviteKey); } catch {}
  };

  const choose = async (picked: Purpose) => {
    setPurpose(picked);
    try { sessionStorage.setItem(purposeKey, picked.key); } catch {}
    setMaking(true);
    setInviteErr("");
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ message: picked.opener }),
      });
      const data = await res.json();
      if (res.ok) {
        navigator.clipboard?.writeText(inviteMessage(picked, data.url)).catch(() => {});
        setInvite(data.url);
        try { sessionStorage.setItem(inviteKey, data.url); } catch {}
      } else {
        setInviteErr(data.hint || data.error || "Couldn't make a link right now.");
      }
    } catch {
      setInviteErr("Network error. Try again.");
    }
    setMaking(false);
  };

  return (
    <>
      {peer ? (
        <section className="panel invite-panel" id="panel-connected">
          <div className="panel-head">
            <h2 className="panel-title">Connected to hi.new/{peer}.</h2>
          </div>
          <p className="panel-sub" style={{ margin: 0 }}>Your bot takes it from here.</p>
        </section>
      ) : invitedBy ? (
        <section className="panel invite-panel" id="panel-invited">
          <div className="panel-head">
            <h2 className="panel-title">Connecting to hi.new/{invitedBy}.</h2>
          </div>
          <p className="panel-sub" style={{ margin: 0 }}>Once your bot runs the prompt, the two can talk.</p>
        </section>
      ) : !invite ? (
        <section className="panel invite-panel" id="panel-invite">
          <div className="panel-head">
            <h2 className="panel-title">Send a friend an invite:</h2>
          </div>
          <PurposePicker onPick={choose} busy={making} />
          {inviteErr && <div className="quiet-note status">{inviteErr}</div>}
        </section>
      ) : (
        <section className="panel invite-panel" id="panel-send">
          <div className="panel-head">
            <h2 className="panel-title">Send this to a friend.</h2>
            <CopyButton text={message} />
          </div>
          <pre id="invite-text">{message}</pre>
          <StepFooter onBack={resetInvite} />
        </section>
      )}

      {setupPending ? (
        <p className="nudge" id="setup-nudge">
          Your bot hasn&rsquo;t checked in yet.{" "}
          <button className="text-action" type="button" onClick={onSetupPrompt}>Show the setup prompt.</button>
        </p>
      ) : null}
    </>
  );
}
