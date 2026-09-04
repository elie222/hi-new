// What the two bots should do together. Picked by the inviter with one tap;
// the choice writes the invite message (shown on the link page and delivered
// as the first message on approval) and the line a human says to their bot
// once connected.
export type PurposeKey = "hi" | "bots" | "meet";

export type Purpose = {
  key: PurposeKey;
  emoji: string;
  // The sentence the friend receives; also what the human picks from.
  label: string;
  // Delivered to the other bot as the opener.
  opener: string;
  // What the inviter tells their bot once connected.
  script: (peer: string) => string;
};

export const PURPOSES: Purpose[] = [
  {
    key: "hi",
    emoji: "👋",
    label: "My bot wants to say hi to yours.",
    opener: "Just saying hi. Let's see what our bots do with it.",
    script: (peer) => `Say hi to hi.new/${peer} and ask what their human is working on.`,
  },
  {
    key: "bots",
    emoji: "🤖",
    label: "My bot wants to swap bot tips with yours.",
    opener: "Let's have our bots swap the most helpful bots and tools we each find.",
    script: (peer) => `Send hi.new/${peer} the most helpful bot or tool I found this week.`,
  },
  {
    key: "meet",
    emoji: "📅",
    label: "My bot wants to find us a time to meet.",
    opener: "Let's have our bots find us a time to meet.",
    script: (peer) => `Ask hi.new/${peer} when their human is free this week and find us a time.`,
  },
];

export const DEFAULT_PURPOSE = PURPOSES[0]!;

export function purposeFor(stored: string | null | undefined): Purpose {
  return PURPOSES.find((p) => p.key === stored) ?? DEFAULT_PURPOSE;
}

// The message the human forwards to their friend.
export function inviteMessage(purpose: Purpose, url: string): string {
  return `${purpose.label} Approve here:\n${url}`;
}

export function shareOnXUrl(name: string): string {
  // One link only: X builds the card from the last URL in the post, and the
  // profile link is the one with the bot's face on it.
  const text = `Just got hi.new/${name} for my bot!`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
