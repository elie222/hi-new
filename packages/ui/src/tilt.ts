// The card turns to face the pointer as one rigid piece; skipped for touch
// and reduced motion. Browser-only, but typed structurally so the package
// also compiles inside the Worker, which has no DOM lib.
type PointerPosition = { clientX: number; clientY: number };

export type TiltTarget = {
  style: { transform: string };
  classList: { contains(name: string): boolean; add(name: string): void; remove(name: string): void };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(type: "pointermove" | "pointerleave", listener: (event: PointerPosition) => void): void;
  removeEventListener(type: "pointermove" | "pointerleave", listener: (event: PointerPosition) => void): void;
};

type TiltView = {
  matchMedia(query: string): { matches: boolean };
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(id: number): void;
};

function attachTiltWithView(
  card: TiltTarget,
  view: TiltView,
  returnCleanup = true,
): (() => void) | undefined {
  if (!view.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  if (view.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const maxTilt = 10;
  let targetX = 0, targetY = 0, curX = 0, curY = 0, raf = 0;
  const frame = () => {
    curX += (targetX - curX) * 0.16;
    curY += (targetY - curY) * 0.16;
    card.style.transform =
      `rotateX(${(-curY * maxTilt).toFixed(2)}deg) rotateY(${(curX * maxTilt).toFixed(2)}deg)` +
      (card.classList.contains("is-lifted") ? " scale(1.02)" : "");
    raf = Math.abs(targetX - curX) + Math.abs(targetY - curY) > 0.0005 ? view.requestAnimationFrame(frame) : 0;
  };
  const kick = () => { if (!raf) raf = view.requestAnimationFrame(frame); };
  const move = (e: PointerPosition) => {
    const r = card.getBoundingClientRect();
    targetX = Math.max(-0.5, Math.min(0.5, (e.clientX - r.left) / r.width - 0.5));
    targetY = Math.max(-0.5, Math.min(0.5, (e.clientY - r.top) / r.height - 0.5));
    card.classList.add("is-lifted");
    kick();
  };
  const leave = () => { targetX = targetY = 0; card.classList.remove("is-lifted"); kick(); };
  card.addEventListener("pointermove", move);
  card.addEventListener("pointerleave", leave);
  if (!returnCleanup) return;
  return () => {
    card.removeEventListener("pointermove", move);
    card.removeEventListener("pointerleave", leave);
    view.cancelAnimationFrame(raf);
  };
}

const view = globalThis as unknown as TiltView;

// Returns the cleanup that detaches the listeners.
export function attachTilt(card: TiltTarget): (() => void) | undefined {
  return attachTiltWithView(card, view);
}

// Server-rendered pages have no client bundle, so embed the same implementation.
export const TILT_SCRIPT = `
document.querySelectorAll("[data-tilt]").forEach(function(card){
  (${attachTiltWithView.toString()})(card, window, false);
});`;
