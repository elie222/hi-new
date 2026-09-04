import { newIdentity } from "../../packages/cli/src/crypto";
import { Store } from "../../packages/cli/src/store";
import { setupCodePrompt } from "../../packages/ui/src/prompts";
import { inviteMessage, purposeFor } from "../../packages/ui/src/purposes";
import type {
  ApiCall,
  ExistingInviteFixture,
  PromptStyle,
  Scenario,
  ScenarioFixture,
  UnconfiguredInviteFixture,
} from "./types";

const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 7)}`;

async function createInviteFixture(
  kind: "invite-existing" | "invite-unconfigured",
  promptStyle: PromptStyle,
  api: ApiCall,
  origin: string,
  hiNewHome: string,
): Promise<ExistingInviteFixture | UnconfiguredInviteFixture> {
  const inviter = unique("friend");
  const claim = await api<{ token: string }>(
    "/api/handles",
    { method: "POST", body: JSON.stringify({ name: inviter }) },
    undefined,
    201,
  );
  const purpose = purposeFor("bots");
  const invite = await api<{ token: string; url: string }>(
    "/api/invites",
    { method: "POST", body: JSON.stringify({ message: purpose.opener }) },
    claim.json.token,
    201,
  );
  const shared = {
    kind,
    inviter,
    opener: purpose.opener,
    inviteToken: invite.json.token,
    prompt: promptStyle === "natural"
      ? `i got this invite to chat with my friend: ${invite.json.url}`
      : inviteMessage(purpose, invite.json.url),
    promptSource: promptStyle === "natural" ? "literal_user_fixture" as const : "inviteMessage" as const,
  };
  if (kind === "invite-unconfigured") return shared;

  const name = unique("newbot");
  const keys = await newIdentity();
  const recipient = await api<{ token: string }>(
    "/api/handles",
    { method: "POST", body: JSON.stringify({ name, public_key: keys.publicKey }) },
    undefined,
    201,
  );
  const inbox = await api<{ messages: { id: number }[] }>("/api/inbox", {}, recipient.json.token, 200);
  if (inbox.json.messages.length > 0) {
    await api(
      "/api/inbox/ack",
      { method: "POST", body: JSON.stringify({ ids: inbox.json.messages.map((message) => message.id) }) },
      recipient.json.token,
      200,
    );
  }
  new Store(hiNewHome).save({
    name,
    token: recipient.json.token,
    identity: keys.identity,
    publicKey: keys.publicKey,
    origin,
  });
  return { ...shared, kind, name, token: recipient.json.token };
}

export async function createFixture(options: {
  scenario: Scenario;
  promptStyle: PromptStyle;
  api: ApiCall;
  origin: string;
  hiNewHome: string;
}): Promise<ScenarioFixture> {
  const { scenario, promptStyle, api, origin, hiNewHome } = options;
  if (scenario !== "setup") {
    return createInviteFixture(scenario, promptStyle, api, origin, hiNewHome);
  }

  const name = unique("eval");
  const claim = await api<{ token: string }>(
    "/api/handles",
    { method: "POST", body: JSON.stringify({ name }) },
    undefined,
    201,
  );
  const setup = await api<{ code: string }>(
    "/api/handles/me/setup-code",
    { method: "POST" },
    claim.json.token,
    200,
  );
  return {
    kind: "setup",
    name,
    token: claim.json.token,
    prompt: setupCodePrompt(origin, name, setup.json.code),
    promptSource: "setupCodePrompt",
  };
}
