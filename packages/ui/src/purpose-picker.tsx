import { PURPOSES, type Purpose } from "./purposes";

export function PurposePicker({ onPick, busy }: { onPick: (purpose: Purpose) => void; busy: boolean }) {
  return (
    <div className="choice-list">
      {PURPOSES.map((p) => (
        <button key={p.key} type="button" className="choice-row" disabled={busy} onClick={() => onPick(p)}>
          <span className="choice-text"><span className="choice-emoji" aria-hidden="true">{p.emoji}</span>&ldquo;{p.label}&rdquo;</span>
          <span className="choice-arrow" aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  );
}
