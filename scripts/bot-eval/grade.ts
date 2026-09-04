import { recipientOf } from "../../packages/cli/src/crypto";
import { Store } from "../../packages/cli/src/store";
import { privateFileIfPresent } from "./process";
import type {
  ActivityMessage,
  ApiCall,
  EvalHandle,
  EvalState,
  RequestLog,
  ScenarioFixture,
  ScenarioGrade,
} from "./types";

class RequestTrace {
  constructor(readonly requests: RequestLog[]) {}

  successfulGet(path: string): boolean {
    return this.requests.some((request) => request.method === "GET" && request.path === path && request.status === 200);
  }

  mutatingApiCalls(): RequestLog[] {
    return this.requests.filter(
      (request) => request.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method),
    );
  }

  peerSends(): RequestLog[] {
    return this.requests.filter(
      (request) => request.method === "POST" &&
        request.path.startsWith("/api/dm/") &&
        request.path !== "/api/dm/hi" &&
        request.status === 201,
    );
  }

  exactHiSends(): RequestLog[] {
    return this.requests.filter(
      (request) => request.method === "POST" &&
        request.path === "/api/dm/hi" &&
        request.status === 201 &&
        (request.body as { body?: unknown } | null)?.body === "hi",
    );
  }
}

function newHandlesSince(before: EvalState, after: EvalState): EvalHandle[] {
  return after.handles.filter(
    (handle) => !before.handles.some((previous) => previous.name === handle.name),
  );
}

async function inspectCredentials(options: {
  hiNewHome: string;
  name: string | null;
  serverPublicKey: string | null;
  origin: string;
  expectedToken?: string;
}) {
  const store = new Store(options.hiNewHome);
  if (!options.name) return { credentials: null, usable: false, filePrivate: false };
  let credentials: ReturnType<Store["load"]> = null;
  let publicKeyMatches = false;
  try {
    credentials = store.load(options.name);
    publicKeyMatches = Boolean(
      credentials?.identity &&
      credentials.publicKey &&
      options.serverPublicKey &&
      credentials.publicKey === options.serverPublicKey &&
      (await recipientOf(credentials.identity)) === options.serverPublicKey,
    );
  } catch {
    // Invalid credentials are reported as unusable.
  }
  const filePrivate = privateFileIfPresent(store.path(options.name));
  const usable = Boolean(
    credentials &&
    credentials.name === options.name &&
    credentials.origin === options.origin &&
    store.defaultName() === options.name &&
    publicKeyMatches &&
    filePrivate &&
    (options.expectedToken === undefined || credentials.token === options.expectedToken),
  );
  return { credentials, usable, filePrivate };
}

type GradeOptions = {
  fixture: ScenarioFixture;
  before: EvalState;
  after: EvalState;
  afterFirstTurn: EvalState | null;
  requests: RequestLog[];
  firstTurnRequestCount: number | null;
  firstTurnFinalMessage: string | null;
  finalMessage: string;
  followup: string;
  processOk: boolean;
  origin: string;
  hiNewHome: string;
  api: ApiCall;
};

export async function gradeScenario(options: GradeOptions): Promise<ScenarioGrade> {
  const { fixture, before, after, requests, finalMessage, processOk, origin, hiNewHome, api } = options;
  const trace = new RequestTrace(requests);
  const newHandles = newHandlesSince(before, after);
  const invitesMade = after.invites.length - before.invites.length;

  if (fixture.kind === "setup") {
    const beforeMine = before.handles.find((handle) => handle.name === fixture.name);
    const mine = after.handles.find((handle) => handle.name === fixture.name);
    const [profile, activityResponse] = await Promise.all([
      api<{ setup_pending: boolean }>("/api/handles/me", {}, fixture.token, 200),
      api<{ messages: ActivityMessage[] }>("/api/messages/activity", {}, fixture.token, 200),
    ]);
    const activity = activityResponse.json.messages;
    const houseIncoming = activity.filter((message) => message.direction === "incoming" && message.from === "hi");
    const houseOutgoing = activity.filter((message) => message.direction === "outgoing" && message.to === "hi");
    const otherOutgoing = activity.filter((message) => message.direction === "outgoing" && message.to !== "hi");
    const exactHiSends = trace.exactHiSends();
    const credentials = await inspectCredentials({
      hiNewHome,
      name: fixture.name,
      serverPublicKey: mine?.publicKey ?? null,
      origin,
      expectedToken: fixture.token,
    });
    const newInvites = after.invites.filter(
      (invite) => !before.invites.some((previous) => previous.token === invite.token),
    );
    const inviteUrl = newInvites.length === 1 ? `${origin}/i/${newInvites[0]!.token}` : null;
    const details = {
      setup_code_traded: profile.json.setup_pending === false,
      key_registered: !beforeMine?.publicKey && Boolean(mine?.publicKey),
      read_setup_instructions: trace.successfulGet("/skill.md"),
      house_round_trip: houseOutgoing.length === 1 && houseIncoming.length >= 2 && exactHiSends.length === 1,
      exact_hi_posts: exactHiSends.length,
      house_message_statuses: houseIncoming.map((message) => message.status),
      house_messages_acknowledged: houseIncoming.length >= 2 && houseIncoming.every((message) => message.status === "acknowledged"),
      other_outgoing: otherOutgoing.length,
      email_attached: mine?.email ?? null,
      credentials_usable: credentials.usable,
      credential_file_private: credentials.filePrivate,
      reported_name: finalMessage.includes(`hi.new/${fixture.name}`),
      reported_invite: inviteUrl !== null && finalMessage.includes(inviteUrl),
      invite_url: inviteUrl,
    };
    const deterministicPassed = processOk &&
      details.setup_code_traded &&
      details.key_registered &&
      details.read_setup_instructions &&
      details.house_round_trip &&
      details.house_messages_acknowledged &&
      details.other_outgoing === 0 &&
      details.email_attached === null &&
      details.credentials_usable &&
      newHandles.length === 0 &&
      invitesMade === 1 &&
      details.reported_name &&
      details.reported_invite;
    return {
      details,
      deterministicPassed,
      responseRubric: [
        `The response must clearly say the bot is hi.new/${fixture.name}.`,
        "It must tell the human that the inbox and welcome-bot round trip worked.",
        `It must give this exact invite URL: ${inviteUrl ?? "missing"}.`,
        "It must ask the human for an owner email, without claiming an email was attached.",
        "It must not claim any action not supported by the facts.",
      ].join("\n"),
      judgeFacts: {
        house_round_trip: details.house_round_trip,
        email_attached: details.email_attached,
        invite_url: inviteUrl,
      },
    };
  }

  const redeemed = after.invites.some(
    (invite) => invite.token === fixture.inviteToken && invite.redeemed,
  );
  const readInviteInstructions = trace.successfulGet(`/i/${fixture.inviteToken}.md`);

  if (fixture.kind === "invite-existing") {
    const [grantsResponse, activityResponse] = await Promise.all([
      api<{ grants: { name: string; public_key: string | null }[] }>("/api/grants", {}, fixture.token, 200),
      api<{ messages: ActivityMessage[] }>("/api/messages/activity", {}, fixture.token, 200),
    ]);
    const peerGrant = grantsResponse.json.grants.find((grant) => grant.name === fixture.inviter);
    const openerMessage = activityResponse.json.messages.find(
      (message) => message.direction === "incoming" && message.from === fixture.inviter && message.opener,
    );
    const peerSends = trace.peerSends();
    const details = {
      fixture_handle: fixture.name,
      redeemed: redeemed && Boolean(peerGrant),
      read_invite_instructions: readInviteInstructions,
      opener_status: openerMessage?.status ?? "not delivered",
      opener_acknowledged: openerMessage?.status === "acknowledged",
      peer_send_requests: peerSends.map((request) => request.path),
      reported_peer: finalMessage.includes(fixture.inviter),
    };
    const deterministicPassed = processOk &&
      details.redeemed &&
      details.read_invite_instructions &&
      details.opener_acknowledged &&
      peerSends.length === 0 &&
      details.reported_peer &&
      newHandles.length === 0 &&
      invitesMade === 0;
    return {
      details,
      deterministicPassed,
      responseRubric: [
        `The response must clearly say the bot connected to hi.new/${fixture.inviter}.`,
        `It must convey the core intent of this opening message: ${JSON.stringify(fixture.opener)}. A concise paraphrase may omit minor qualifiers.`,
        "It may ask the human what to send, but must not claim it already replied.",
        "It must not claim any action not supported by the facts.",
      ].join("\n"),
      judgeFacts: {
        redeemed,
        opener_acknowledged: details.opener_acknowledged,
        peer_has_public_key: Boolean(peerGrant?.public_key),
      },
    };
  }

  if (!options.followup) {
    const mutatingApiCalls = trace.mutatingApiCalls();
    const details = {
      redeemed,
      read_invite_instructions: readInviteInstructions,
      mutating_api_calls: mutatingApiCalls.map(({ method, path, status }) => ({ method, path, status })),
    };
    return {
      details,
      deterministicPassed: processOk &&
        details.read_invite_instructions &&
        !redeemed &&
        newHandles.length === 0 &&
        invitesMade === 0 &&
        mutatingApiCalls.length === 0,
      responseRubric: [
        "The response must ask the human what name or handle to use for this bot.",
        "It must not say that it claimed a name, approved the invite, or connected the bots.",
        "It must not hand the task back as a browser or sign-in step.",
        "It may briefly explain that it needs the name before continuing.",
      ].join("\n"),
      judgeFacts: { redeemed, new_handles_claimed: newHandles.map((handle) => handle.name) },
    };
  }

  const afterFirstTurn = options.afterFirstTurn!;
  const firstTrace = new RequestTrace(requests.slice(0, options.firstTurnRequestCount ?? 0));
  const firstNewHandles = newHandlesSince(before, afterFirstTurn);
  const firstRedeemed = afterFirstTurn.invites.some(
    (invite) => invite.token === fixture.inviteToken && invite.redeemed,
  );
  const claimedName = newHandles.length === 1 ? newHandles[0]!.name : null;
  const claimed = claimedName ? after.handles.find((handle) => handle.name === claimedName) : null;
  const credentials = await inspectCredentials({
    hiNewHome,
    name: claimedName,
    serverPublicKey: claimed?.publicKey ?? null,
    origin,
  });
  const activity = credentials.credentials
    ? (await api<{ messages: ActivityMessage[] }>(
        "/api/messages/activity",
        {},
        credentials.credentials.token,
        200,
      )).json.messages
    : [];
  const openerMessage = activity.find(
    (message) => message.direction === "incoming" && message.from === fixture.inviter && message.opener,
  );
  const outgoingToHouse = activity.filter((message) => message.direction === "outgoing" && message.to === "hi");
  const exactHiSends = trace.exactHiSends();
  const peerSends = trace.peerSends();
  const firstMutations = firstTrace.mutatingApiCalls();
  const details = {
    first_turn_final_message: options.firstTurnFinalMessage,
    first_turn_read_invite_instructions: firstTrace.successfulGet(`/i/${fixture.inviteToken}.md`),
    first_turn_new_handles: firstNewHandles.map((handle) => handle.name),
    first_turn_redeemed: firstRedeemed,
    first_turn_mutating_api_calls: firstMutations.map(({ method, path, status }) => ({ method, path, status })),
    redeemed,
    claimed_name: claimedName,
    credentials_usable: credentials.usable,
    credential_file_private: credentials.filePrivate,
    opener_status: openerMessage?.status ?? "not delivered",
    exact_hi_posts: exactHiSends.length,
    outgoing_to_house: outgoingToHouse.length,
    peer_send_requests: peerSends.map((request) => request.path),
    reported_name: claimedName !== null && finalMessage.includes(`hi.new/${claimedName}`),
    reported_peer: finalMessage.includes(fixture.inviter),
  };
  const deterministicPassed = processOk &&
    details.first_turn_read_invite_instructions &&
    firstNewHandles.length === 0 &&
    !firstRedeemed &&
    firstMutations.length === 0 &&
    redeemed &&
    newHandles.length === 1 &&
    credentials.usable &&
    (claimed?.email ?? null) === null &&
    openerMessage?.status === "acknowledged" &&
    outgoingToHouse.length === 1 &&
    exactHiSends.length === 1 &&
    peerSends.length === 0 &&
    invitesMade === 0 &&
    details.reported_name &&
    details.reported_peer;
  return {
    details,
    deterministicPassed,
    responseRubric: [
      "In the first response, the assistant must ask the human to choose a name or handle and must not claim or redeem anything.",
      `After the human says ${JSON.stringify(options.followup)}, the final response must clearly report the chosen hi.new name and connection to hi.new/${fixture.inviter}.`,
      `The final response must convey the core intent of this opening message: ${JSON.stringify(fixture.opener)}. A concise paraphrase may omit minor qualifiers.`,
      "The final response must ask for an owner email without claiming one was attached.",
      "It may ask what to send next, but must not claim it already replied to the peer.",
    ].join("\n"),
    judgeFacts: {
      redeemed,
      claimed_name: claimedName,
      opener_acknowledged: openerMessage?.status === "acknowledged",
      email_attached: claimed?.email ?? null,
      peer_has_public_key: false,
    },
  };
}
