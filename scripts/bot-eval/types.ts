export type Agent = "codex" | "claude" | "cursor";
export type Scenario = "setup" | "invite-existing" | "invite-unconfigured";
export type PromptStyle = "app-share" | "natural";

export type RequestLog = {
  method: string;
  path: string;
  status: number | null;
  userAgent: string;
  body?: unknown;
};

export type EvalHandle = {
  name: string;
  email: string | null;
  publicKey: string | null;
};

export type EvalInvite = {
  token: string;
  creator: string;
  message: string;
  redeemed: boolean;
};

export type EvalState = {
  handles: EvalHandle[];
  invites: EvalInvite[];
};

export type ActivityMessage = {
  direction: "incoming" | "outgoing";
  from: string;
  to: string;
  status: string;
  opener?: boolean;
};

type FixtureBase = {
  prompt: string;
  promptSource: "setupCodePrompt" | "inviteMessage" | "literal_user_fixture";
};

export type SetupFixture = FixtureBase & {
  kind: "setup";
  name: string;
  token: string;
};

export type ExistingInviteFixture = FixtureBase & {
  kind: "invite-existing";
  name: string;
  token: string;
  inviter: string;
  opener: string;
  inviteToken: string;
};

export type UnconfiguredInviteFixture = FixtureBase & {
  kind: "invite-unconfigured";
  inviter: string;
  opener: string;
  inviteToken: string;
};

export type ScenarioFixture = SetupFixture | ExistingInviteFixture | UnconfiguredInviteFixture;

export type ProcessRun = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  threadId: string | null;
};

export type ApiCall = <T>(
  path: string,
  init?: RequestInit,
  token?: string,
  expectedStatus?: number,
) => Promise<{ status: number; json: T }>;

export type ScenarioGrade = {
  details: Record<string, unknown>;
  deterministicPassed: boolean;
  responseRubric: string;
  judgeFacts: Record<string, unknown>;
};
