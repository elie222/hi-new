import { describe, expect, test } from "bun:test";
import { call, connect, makeTestApp, signup, peers } from "./helpers";

async function mcp(app: any, method: string, params?: unknown, token?: string) {
  return call(app, "POST", "/mcp", {
    token,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    },
  });
}

async function modernMcp(
  app: any,
  method: string,
  params: Record<string, unknown>,
  token: string,
) {
  const protocol = "2026-07-28";
  return call(app, "POST", "/mcp", {
    token,
    headers: {
      "mcp-protocol-version": protocol,
      "mcp-method": method,
      ...(method === "tools/call" && typeof params.name === "string"
        ? { "mcp-name": params.name }
        : {}),
    },
    body: {
      jsonrpc: "2.0",
      id: 2,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocol,
          "io.modelcontextprotocol/clientInfo": {
            name: "test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });
}

async function mcpTool(
  app: any,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await mcp(
    app,
    "tools/call",
    { name, arguments: args },
    token,
  );
  expect(response.status).toBe(200);
  expect(response.json.result.isError).toBe(false);
  return JSON.parse(response.json.result.content[0].text);
}

describe("MCP", () => {
  test("advertises tools and calls the same authenticated API", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const initialized = await mcp(
      app,
      "initialize",
      { protocolVersion: "2025-06-18" },
      alice.token,
    );
    expect(initialized.json.result.serverInfo.name).toBe("hi.new");
    const listed = await mcp(app, "tools/list", {}, alice.token);
    expect(
      listed.json.result.tools.some(
        (tool: any) => tool.name === "open_message",
      ),
    ).toBe(true);

    const called = await mcp(
      app,
      "tools/call",
      { name: "create_invite", arguments: {} },
      alice.token,
    );
    expect(called.status).toBe(200);
    expect(called.json.result.isError).toBe(false);
    const value = JSON.parse(called.json.result.content[0].text);
    expect(value.token).toStartWith("hni_");

    const unauthenticated = await mcp(app, "tools/call", {
      name: "list_messages",
      arguments: {},
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.json.error).toBe("missing_bearer");

    const discovered = await modernMcp(app, "server/discover", {}, alice.token);
    expect(discovered.json.result.supportedVersions).toContain("2026-07-28");
    const modernList = await modernMcp(app, "tools/list", {}, alice.token);
    expect(modernList.json.result.resultType).toBe("complete");
    expect(modernList.json.result.cacheScope).toBe("private");
    const modernCall = await modernMcp(
      app,
      "tools/call",
      { name: "get_profile", arguments: {} },
      alice.token,
    );
    expect(modernCall.json.result.resultType).toBe("complete");
    expect(JSON.parse(modernCall.json.result.content[0].text).name).toBe("alice-bot");

    const notification = await mcpTool(app, alice.token, "create_notification", {
      kind: "webhook",
      name: "Grok inbox",
      endpoint: {
        url: "https://api2.cursor.sh/automations/webhook/01234567-89ab-cdef-0123-456789abcdef",
        headers: { Authorization: "Bearer crsr_test_secret" },
      },
    });
    expect(notification.destination).toMatchObject({
      kind: "webhook",
      name: "Grok inbox",
    });
    const notifications = await mcpTool(app, alice.token, "list_notifications");
    expect(notifications.destinations).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toContain("crsr_test_secret");

    const mismatch = await call(app, "POST", "/mcp", {
      token: alice.token,
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "wrong_tool",
      },
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_messages",
          arguments: {},
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.code).toBe(-32020);

    const forbiddenOrigin = await call(app, "POST", "/mcp", {
      token: alice.token,
      headers: { origin: "https://attacker.example" },
      body: { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
    });
    expect(forbiddenOrigin.status).toBe(403);
  });

  test("rejects malformed, unsupported, and incomplete protocol requests", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");

    const get = await app.request("http://hi.test/mcp");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const malformed = await app.request("http://hi.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.token}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error.code).toBe(-32700);

    const invalid = await call(app, "POST", "/mcp", {
      token: alice.token,
      body: { id: 1, method: "tools/list", params: {} },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.code).toBe(-32600);

    const unsupported = await call(app, "POST", "/mcp", {
      token: alice.token,
      headers: {
        "mcp-protocol-version": "1900-01-01",
        "mcp-method": "tools/list",
      },
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.error.code).toBe(-32022);
    expect(unsupported.json.error.data.supported).toContain("2026-07-28");

    const missingMetadata = await call(app, "POST", "/mcp", {
      token: alice.token,
      headers: {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      },
    });
    expect(missingMetadata.status).toBe(400);
    expect(missingMetadata.json.error.code).toBe(-32602);

    const modernInitialize = await modernMcp(
      app,
      "initialize",
      { protocolVersion: "2026-07-28" },
      alice.token,
    );
    expect(modernInitialize.status).toBe(404);
    expect(modernInitialize.json.error.code).toBe(-32601);
    const unknown = await mcp(app, "not/a-method", {}, alice.token);
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe(-32601);
    expect((await mcp(app, "notifications/initialized", {}, alice.token)).status).toBe(202);
  });

  test("keeps tool errors in-band and preserves scoped approval boundaries", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    await connect(app, alice, bob);
    await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: "approve me", enc: "none" },
    });
    const credential = await call(app, "POST", "/api/tokens", {
      token: alice.token,
      body: { name: "metadata only", scopes: ["messages:list"] },
    });

    const listed = await mcp(
      app,
      "tools/call",
      { name: "list_messages", arguments: {} },
      credential.json.token,
    );
    expect(listed.status).toBe(200);
    expect(listed.json.result.isError).toBe(false);
    const headers = JSON.parse(listed.json.result.content[0].text);
    const message = headers.messages.find(
      (item: any) => item.from === "bob-bot" && item.tag === "granted",
    );
    expect(message.body).toBeUndefined();

    const blockedOpen = await mcp(
      app,
      "tools/call",
      { name: "open_message", arguments: { id: message.id } },
      credential.json.token,
    );
    expect(blockedOpen.status).toBe(200);
    expect(blockedOpen.json.result.isError).toBe(true);
    expect(JSON.parse(blockedOpen.json.result.content[0].text)).toEqual({
      error: "insufficient_scope",
      required: "messages:read",
    });

    const unknownTool = await mcp(
      app,
      "tools/call",
      { name: "does_not_exist", arguments: {} },
      credential.json.token,
    );
    expect(unknownTool.status).toBe(200);
    expect(unknownTool.json.result.isError).toBe(true);
    expect(JSON.parse(unknownTool.json.result.content[0].text).error).toBe("unknown_tool");

    const tools = await mcp(app, "tools/list", {}, credential.json.token);
    expect(tools.json.result.tools.map((tool: any) => tool.name)).toEqual([
      "get_profile",
      "update_profile",
      "list_notifications",
      "create_notification",
      "update_notification",
      "delete_notification",
      "create_invite",
      "redeem_invite",
      "list_contacts",
      "revoke_contact",
      "list_messages",
      "open_message",
      "list_message_activity",
      "ack_messages",
      "send_message",
      "create_group",
      "list_groups",
      "get_group",
      "create_group_invite",
      "join_group",
      "leave_group",
      "remove_group_member",
      "delete_group",
      "send_group_message",
    ]);
    const byName = new Map(tools.json.result.tools.map((tool: any) => [tool.name, tool]));
    expect((byName.get("open_message") as any).annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect((byName.get("ack_messages") as any).annotations.destructiveHint).toBe(true);
    expect((byName.get("delete_group") as any).annotations.destructiveHint).toBe(true);
  });

  test("maps a complete direct and group lifecycle through MCP tools", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");

    expect((await mcpTool(app, alice.token, "get_profile")).name).toBe("alice-bot");
    expect(
      (await mcpTool(app, alice.token, "update_profile", { webhook_url: null })).ok,
    ).toBe(true);

    const invite = await mcpTool(app, alice.token, "create_invite");
    expect((await mcpTool(app, bob.token, "redeem_invite", { token: invite.token })).granted).toBe(
      true,
    );
    expect(peers((await mcpTool(app, alice.token, "list_contacts")).grants)).toHaveLength(1);
    await mcpTool(app, alice.token, "send_message", {
      to: "bob-bot",
      body: "hello through MCP",
      enc: "none",
    });
    let headers = await mcpTool(app, bob.token, "list_messages");
    let message = headers.messages.find((item: any) => item.tag === "granted" && item.from !== "hi");
    expect((await mcpTool(app, bob.token, "open_message", { id: message.id })).body).toBe(
      "hello through MCP",
    );
    expect((await mcpTool(app, bob.token, "ack_messages", { ids: [message.id] })).deleted).toBe(1);
    const activity = await mcpTool(app, bob.token, "list_message_activity");
    expect(activity.messages.find((item: any) => item.id === message.id).status).toBe(
      "acknowledged",
    );

    const group = await mcpTool(app, alice.token, "create_group", { name: "MCP group" });
    await mcpTool(app, bob.token, "join_group", { token: group.invite.token });
    expect((await mcpTool(app, alice.token, "list_groups")).groups).toHaveLength(1);
    expect((await mcpTool(app, alice.token, "get_group", { id: group.id })).members).toHaveLength(2);
    expect(
      (await mcpTool(app, alice.token, "create_group_invite", { id: group.id })).invite.token,
    ).toStartWith("hngi_");
    await mcpTool(app, alice.token, "send_group_message", {
      id: group.id,
      body: "group hello",
      enc: "none",
    });
    headers = await mcpTool(app, bob.token, "list_messages");
    message = headers.messages.find((item: any) => item.tag === "group");
    expect((await mcpTool(app, bob.token, "open_message", { id: message.id })).body).toBe(
      "group hello",
    );
    await mcpTool(app, bob.token, "ack_messages", { ids: [message.id] });

    expect((await mcpTool(app, bob.token, "leave_group", { id: group.id })).removed).toBe(
      "bob-bot",
    );
    const rejoin = await mcpTool(app, alice.token, "create_group_invite", { id: group.id });
    await mcpTool(app, bob.token, "join_group", { token: rejoin.invite.token });
    expect(
      (await mcpTool(app, alice.token, "remove_group_member", {
        id: group.id,
        name: "bob-bot",
      })).removed,
    ).toBe("bob-bot");
    expect((await mcpTool(app, alice.token, "revoke_contact", { name: "bob-bot" })).revoked).toBe(
      "bob-bot",
    );
    expect((await mcpTool(app, alice.token, "delete_group", { id: group.id })).deleted).toBe(
      group.id,
    );
  });
});
