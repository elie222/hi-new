// Thin client over the hi.new JSON API. `fetch` is injectable so tests can
// point it at an in-memory app.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }

  get hint(): string | null {
    return typeof this.body.hint === "string" ? this.body.hint : null;
  }
}

export type Json = Record<string, any>;

export type Message = {
  id: number;
  from: string;
  tag: string | null;
  enc: "age" | "none";
  bytes: number;
  body: string;
  created_at: string;
  expires_at: string;
  group: { id: string; name: string } | null;
};

export class Api {
  readonly origin: string;

  constructor(
    private readonly opts: {
      origin: string;
      fetch: FetchLike;
      userAgent: string;
      token?: string | null;
    },
  ) {
    this.origin = opts.origin.replace(/\/+$/, "");
  }

  withToken(token: string): Api {
    return new Api({ ...this.opts, token });
  }

  async request(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
  ): Promise<Json> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.opts.userAgent,
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth !== false && this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    const res = await this.opts.fetch(`${this.origin}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: `HTTP ${res.status}`, raw: text.slice(0, 500) };
    }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }

  claim(body: { name: string; public_key?: string; email?: string }, token: string): Promise<Json> {
    return this.request("POST", "/api/handles", { body, auth: false, headers: { "x-hi-new-claim-token": token } });
  }

  setup(code: string): Promise<Json> {
    return this.request("POST", "/api/setup", { body: { code }, auth: false });
  }

  me(): Promise<Json> {
    return this.request("GET", "/api/handles/me");
  }

  patchMe(patch: { public_key?: string | null; email?: string }): Promise<Json> {
    return this.request("PATCH", "/api/handles/me", { body: patch });
  }

  handle(name: string): Promise<Json> {
    return this.request("GET", `/api/handles/${encodeURIComponent(name)}`, { auth: false });
  }

  inbox(): Promise<Json & { messages: Message[] }> {
    return this.request("GET", "/api/inbox") as Promise<Json & { messages: Message[] }>;
  }

  ack(ids: number[]): Promise<Json> {
    return this.request("POST", "/api/inbox/ack", { body: { ids } });
  }

  dm(name: string, body: string, enc: "age" | "none", idempotencyKey: string, recipientKey: string | null): Promise<Json> {
    return this.request("POST", `/api/dm/${encodeURIComponent(name)}`, {
      body: { body, enc, recipient_public_key: recipientKey },
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  invite(message?: string): Promise<Json> {
    return this.request("POST", "/api/invites", { body: message ? { message } : {} });
  }

  redeem(token: string): Promise<Json> {
    return this.request("POST", `/api/invites/${encodeURIComponent(token)}/redeem`, { body: {} });
  }

  grants(): Promise<Json & { grants: Json[] }> {
    return this.request("GET", "/api/grants") as Promise<Json & { grants: Json[] }>;
  }
}
