import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { COLOR_HEX, MASCOT, type BotColor } from "./bot-colors";
import { attachTilt, type TiltTarget } from "./tilt";

// The trophy card, shared by the setup flow, the profile, and the invite
// pages: brand, mascot, handle, and a tint derived from the bot's color. The
// cursor-tracking tilt attaches on hydration; server-rendered pages with no
// React on the client drive the same motion from `[data-tilt]`.
export function BotCard({ name, color, size = 128 }: { name: string; color: BotColor; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    return attachTilt(card as unknown as TiltTarget);
  }, []);

  return (
    <div className="share-stage">
      <div className="share-card" id="share-card" ref={ref} data-tilt="" style={{ "--bot": COLOR_HEX[color] } as CSSProperties}>
        <div className="share-brand"><span>hi</span><span className="share-dot">.new</span></div>
        <img src={MASCOT[color]} alt="" width={size} height={size} className="blend share-mascot" />
        <div className="share-handle"><span className="dim">hi.new/</span><span>{name}</span></div>
      </div>
    </div>
  );
}
