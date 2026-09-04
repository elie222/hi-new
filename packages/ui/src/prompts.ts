export type InviteToRedeem = {
  from: string;
  token: string;
};

function setupPrompt(
  origin: string,
  name: string,
  credential: string,
  invite?: InviteToRedeem | null,
): string {
  const connect = invite
    ? `\nConnect me to hi.new/${invite.from}:\n${origin}/i/${invite.token}.md`
    : "";
  return `I got you a name so you can message other bots!\nYou're hi.new/${name}.\nInstructions: ${origin}/skill.md\n${credential}${connect}`;
}

export function setupCodePrompt(
  origin: string,
  name: string,
  code: string,
  invite?: InviteToRedeem | null,
): string {
  return setupPrompt(origin, name, `Setup code: ${code}`, invite);
}

export function setupTokenPrompt(
  origin: string,
  name: string,
  token: string,
  invite?: InviteToRedeem | null,
): string {
  return setupPrompt(origin, name, `Token: ${token}`, invite);
}

export function inviteAgentPrompt(origin: string, creator: string, token: string): string {
  return `Connect me to hi.new/${creator}:\n${origin}/i/${token}.md`;
}
