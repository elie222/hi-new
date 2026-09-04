// Bot colors: the six mascot variants a handle can pick at claim time.
// Stored as a palette key (not a hex) so the art can be retouched without a
// migration. One source for the landing, the Worker, and the share cards.
export const BOT_COLORS = ["blue", "orange", "coral", "teal", "purple", "pink"] as const;
export type BotColor = (typeof BOT_COLORS)[number];

// Swatch fills for the color pickers (sampled from the mascot renders).
export const COLOR_HEX: Record<BotColor, string> = {
  blue: "#3E62E4",
  orange: "#F28B2B",
  coral: "#F26E4F",
  teal: "#56C1B8",
  purple: "#8D6EF1",
  pink: "#F26CA4",
};

export const MASCOT: Record<BotColor, string> = {
  blue: "/img/p613014.png",
  orange: "/img/p617159.png",
  coral: "/img/p962491.png",
  teal: "/img/p621817.png",
  purple: "/img/p972365.png",
  pink: "/img/p975695.png",
};

// Handles claimed before colors existed keep the mascot they always had: this
// is the original eight-image hash order (three of the eight were blue).
const LEGACY_ORDER: readonly BotColor[] = ["blue", "orange", "teal", "coral", "blue", "purple", "pink", "blue"];

export function defaultColorFor(name: string): BotColor {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return LEGACY_ORDER[h % LEGACY_ORDER.length]!;
}

export function isBotColor(value: unknown): value is BotColor {
  return typeof value === "string" && (BOT_COLORS as readonly string[]).includes(value);
}

export function effectiveColor(name: string, color: string | null | undefined): BotColor {
  return isBotColor(color) ? color : defaultColorFor(name);
}

export function mascotFor(name: string, color?: string | null): string {
  return MASCOT[effectiveColor(name, color)];
}

// The swatch hexes tuned for legible text on white (darkened where needed).
const NAME_HEX: Record<BotColor, string> = {
  blue: "#3E62E4",
  orange: "#D07716",
  coral: "#E05A38",
  teal: "#188F85",
  purple: "#7C5CE8",
  pink: "#DB4E8C",
};

export function nameColorFor(name: string, color?: string | null): string {
  return NAME_HEX[effectiveColor(name, color)];
}
