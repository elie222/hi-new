import type { NotificationDestination } from "../db/schema";
import { isSafeWebhookUrl } from "./webhook";
import { openSecret, sealSecret } from "./secret-box";

const SECRET_PURPOSE = "notification-destination";
const MAX_ENDPOINT_CHARS = 4096;

export const NOTIFICATION_KINDS = ["webhook", "slack"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type CreateNotificationInput = {
  kind?: unknown;
  name?: unknown;
  endpoint?: unknown;
  active?: unknown;
};

export type InboxNotificationEvent = {
  event: "inbox.new";
  to: string;
  unread: number;
};

export type SealedNotificationDestination = {
  kind: NotificationKind;
  name: string;
  endpointEnc: string;
  active: boolean;
};

export type NotificationDeliveryResult = {
  ok: boolean;
  status: number | null;
  error: string | null;
};

type EndpointResult<T> = { value: T } | { error: string };

type SealedEndpointResult =
  | { value: Pick<SealedNotificationDestination, "endpointEnc"> }
  | { error: string };

export interface NotificationAdapter {
  readonly kind: NotificationKind;
  readonly defaultName: string;
  sealEndpoint(
    encryptionKey: string,
    endpoint: unknown,
  ): Promise<SealedEndpointResult>;
  deliver(
    encryptionKey: string,
    endpointEnc: string,
    event: InboxNotificationEvent,
  ): Promise<Response | null>;
}

type AdapterDefinition<T> = {
  kind: NotificationKind;
  defaultName: string;
  parseEndpoint(endpoint: unknown): EndpointResult<T>;
  deliver(endpoint: T, event: InboxNotificationEvent): Promise<Response>;
};

function defineAdapter<T>(
  definition: AdapterDefinition<T>,
): NotificationAdapter {
  return {
    kind: definition.kind,
    defaultName: definition.defaultName,
    sealEndpoint: async (encryptionKey, endpoint) => {
      const parsed = definition.parseEndpoint(endpoint);
      if ("error" in parsed) return parsed;
      return {
        value: {
          endpointEnc: await sealSecret(
            encryptionKey,
            SECRET_PURPOSE,
            JSON.stringify(parsed.value),
          ),
        },
      };
    },
    deliver: async (encryptionKey, endpointEnc, event) => {
      const serialized = await openSecret(
        encryptionKey,
        SECRET_PURPOSE,
        endpointEnc,
      );
      if (!serialized) return null;
      let endpoint: unknown;
      try {
        endpoint = JSON.parse(serialized);
      } catch {
        return null;
      }
      const parsed = definition.parseEndpoint(endpoint);
      if ("error" in parsed) return null;
      return definition.deliver(parsed.value, event);
    },
  };
}

function isNotificationKind(value: unknown): value is NotificationKind {
  return (
    typeof value === "string" &&
    NOTIFICATION_KINDS.includes(value as NotificationKind)
  );
}

function endpointRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function notificationHeaders(
  value: unknown,
): { value: Record<string, string> } | { error: string } {
  if (value == null) return { value: {} };
  const record = endpointRecord(value);
  if (!record)
    return { error: "endpoint.headers must be an object of string values" };
  const entries = Object.entries(record);
  if (entries.length > 20)
    return { error: "endpoint.headers supports at most 20 entries" };
  const headers: Record<string, string> = {};
  let totalChars = 0;
  const blocked = new Set([
    "connection",
    "content-length",
    "cookie",
    "host",
    "set-cookie",
    "transfer-encoding",
  ]);
  for (const [name, headerValue] of entries) {
    const lowerName = name.toLowerCase();
    if (!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(name) || blocked.has(lowerName)) {
      return { error: `unsupported endpoint header: ${name}` };
    }
    if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      return { error: `endpoint header ${name} must be a single-line string` };
    }
    totalChars += name.length + headerValue.length;
    if (totalChars > 8192) return { error: "endpoint.headers are too large" };
    headers[lowerName] = headerValue;
  }
  return { value: headers };
}

type WebhookEndpoint = {
  url: string;
  headers: Record<string, string>;
};

function parseWebhookEndpoint(value: unknown): EndpointResult<WebhookEndpoint> {
  const endpoint = endpointRecord(value);
  if (!endpoint || !hasOnlyKeys(endpoint, ["url", "headers"])) {
    return {
      error: "webhook endpoint must contain only url and optional headers",
    };
  }
  if (
    typeof endpoint.url !== "string" ||
    endpoint.url.length === 0 ||
    endpoint.url.length > MAX_ENDPOINT_CHARS ||
    !isSafeWebhookUrl(endpoint.url)
  ) {
    return {
      error: `endpoint.url must be a public URL up to ${MAX_ENDPOINT_CHARS} characters`,
    };
  }
  const url = new URL(endpoint.url);
  const headers = notificationHeaders(endpoint.headers);
  if ("error" in headers) return headers;
  if (Object.keys(headers.value).length > 0 && url.protocol !== "https:") {
    return { error: "webhook endpoints with private headers require https" };
  }
  return {
    value: { url: url.toString(), headers: headers.value },
  };
}

type SlackEndpoint = {
  url: string;
};

function parseSlackEndpoint(value: unknown): EndpointResult<SlackEndpoint> {
  const endpoint = endpointRecord(value);
  if (!endpoint || !hasOnlyKeys(endpoint, ["url"])) {
    return { error: "Slack endpoint must contain only url" };
  }
  if (
    typeof endpoint.url !== "string" ||
    endpoint.url.length === 0 ||
    endpoint.url.length > MAX_ENDPOINT_CHARS ||
    !isSafeWebhookUrl(endpoint.url)
  ) {
    return {
      error: `endpoint.url must be a public URL up to ${MAX_ENDPOINT_CHARS} characters`,
    };
  }
  const url = new URL(endpoint.url);
  const slackHost =
    url.hostname === "hooks.slack.com" ||
    url.hostname === "hooks.slack-gov.com";
  if (
    url.protocol !== "https:" ||
    !slackHost ||
    !url.pathname.startsWith("/services/")
  ) {
    return {
      error: "Slack endpoints must use a generated hooks.slack.com URL",
    };
  }
  return {
    value: { url: url.toString() },
  };
}

function post(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

const webhookAdapter = defineAdapter({
  kind: "webhook",
  defaultName: "Webhook",
  parseEndpoint: parseWebhookEndpoint,
  deliver: (endpoint, event) => post(endpoint.url, endpoint.headers, event),
});

const slackAdapter = defineAdapter({
  kind: "slack",
  defaultName: "Slack",
  parseEndpoint: parseSlackEndpoint,
  deliver: (endpoint, event) =>
    post(
      endpoint.url,
      {},
      {
        text: `New hi.new inbox activity for ${event.to}. ${event.unread} unread.`,
      },
    ),
});

const adapters: Record<NotificationKind, NotificationAdapter> = {
  webhook: webhookAdapter,
  slack: slackAdapter,
};

export async function sealNotificationDestination(
  encryptionKey: string,
  input: CreateNotificationInput,
): Promise<{ value: SealedNotificationDestination } | { error: string }> {
  const fields = endpointRecord(input);
  if (!fields || !hasOnlyKeys(fields, ["kind", "name", "endpoint", "active"])) {
    return {
      error: "notification must contain only kind, name, endpoint, and active",
    };
  }
  if (!isNotificationKind(input.kind)) {
    return { error: `kind must be one of: ${NOTIFICATION_KINDS.join(", ")}` };
  }
  const adapter = adapters[input.kind];
  const rawName = input.name == null ? adapter.defaultName : input.name;
  if (
    typeof rawName !== "string" ||
    rawName.trim().length === 0 ||
    rawName.trim().length > 80
  ) {
    return { error: "name must be 1-80 characters" };
  }
  if (input.active != null && typeof input.active !== "boolean") {
    return { error: "active must be a boolean" };
  }
  const sealed = await adapter.sealEndpoint(encryptionKey, input.endpoint);
  if ("error" in sealed) return sealed;
  return {
    value: {
      kind: input.kind,
      name: rawName.trim(),
      ...sealed.value,
      active: input.active ?? true,
    },
  };
}

export async function deliverNotificationDestination(
  encryptionKey: string,
  destination: NotificationDestination,
  event: InboxNotificationEvent,
): Promise<NotificationDeliveryResult> {
  if (!isNotificationKind(destination.kind)) {
    return { ok: false, status: null, error: "unsupported_destination" };
  }
  const adapter = adapters[destination.kind];
  try {
    const response = await adapter.deliver(
      encryptionKey,
      destination.endpointEnc,
      event,
    );
    if (!response)
      return { ok: false, status: null, error: "configuration_unreadable" };
    return response.ok
      ? { ok: true, status: response.status, error: null }
      : {
          ok: false,
          status: response.status,
          error: `http_${response.status}`,
        };
  } catch {
    return { ok: false, status: null, error: "delivery_failed" };
  }
}

export function publicNotificationDestination(
  destination: NotificationDestination,
) {
  return {
    id: destination.id,
    kind: destination.kind,
    name: destination.name,
    active: destination.active,
    failure_count: destination.failureCount,
    last_attempt_at: destination.lastAttemptAt,
    last_success_at: destination.lastSuccessAt,
    last_error: destination.lastError,
    created_at: destination.createdAt,
    updated_at: destination.updatedAt,
  };
}
