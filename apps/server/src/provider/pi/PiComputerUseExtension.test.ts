import { afterEach, expect, it, vi } from "vite-plus/test";

import { T3_COMPUTER_USE_PI_EXTENSION_SOURCE } from "./PiComputerUseExtension.ts";

const originalEndpoint = process.env.T3CODE_MCP_ENDPOINT;
const originalAuthorization = process.env.T3CODE_MCP_AUTHORIZATION;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalEndpoint === undefined) delete process.env.T3CODE_MCP_ENDPOINT;
  else process.env.T3CODE_MCP_ENDPOINT = originalEndpoint;
  if (originalAuthorization === undefined) delete process.env.T3CODE_MCP_AUTHORIZATION;
  else process.env.T3CODE_MCP_AUTHORIZATION = originalAuthorization;
});

it("registers the same governed Computer Use tools in bare Pi and forwards MCP credentials", async () => {
  process.env.T3CODE_MCP_ENDPOINT = "http://127.0.0.1:43123/mcp";
  process.env.T3CODE_MCP_AUTHORIZATION = "Bearer secret-test-token";
  const requests: Array<{ readonly body: unknown; readonly headers: Headers }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; id?: number };
      const headers = new Headers(init?.headers);
      requests.push({ body, headers });
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
          }),
          {
            headers: {
              "content-type": "application/json",
              "mcp-protocol-version": "2025-06-18",
              "mcp-session-id": "mcp-session-1",
            },
          },
        );
      }
      if (headers.get("mcp-protocol-version") !== "2025-06-18") {
        return new Response(null, { status: 400 });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "host ready" }],
            structuredContent: { status: "ready" },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(T3_COMPUTER_USE_PI_EXTENSION_SOURCE).toString("base64")}`;
  const extension = (await import(moduleUrl)) as {
    default: (pi: { registerTool: (tool: unknown) => void }) => void;
  };
  const tools: Array<{
    readonly name: string;
    readonly execute: (...args: Array<unknown>) => Promise<unknown>;
  }> = [];
  extension.default({ registerTool: (tool) => tools.push(tool as (typeof tools)[number]) });

  expect(tools.map((tool) => tool.name)).toEqual([
    "computer_status",
    "computer_list_targets",
    "computer_observe",
    "computer_act",
    "computer_stop",
  ]);
  const status = tools[0];
  expect(status).toBeDefined();
  await expect(status!.execute("call-1", {}, new AbortController().signal)).resolves.toMatchObject({
    content: [{ type: "text", text: "host ready" }],
    details: { status: "ready" },
  });
  expect(requests.map((request) => (request.body as { method?: string }).method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  expect(
    requests.every(
      (request) => request.headers.get("authorization") === "Bearer secret-test-token",
    ),
  ).toBe(true);
  expect(requests[2]?.headers.get("mcp-session-id")).toBe("mcp-session-1");
  expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
});

it("pauses for a T3 approval and retries the governed call only after the user accepts", async () => {
  process.env.T3CODE_MCP_ENDPOINT = "http://127.0.0.1:43123/mcp";
  process.env.T3CODE_MCP_AUTHORIZATION = "Bearer approval-test-token";
  let toolCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; id?: number };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
          }),
          {
            headers: {
              "content-type": "application/json",
              "mcp-protocol-version": "2025-06-18",
              "mcp-session-id": "approval-session",
            },
          },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls += 1;
      const structuredContent =
        toolCalls === 1
          ? {
              _tag: "policy",
              approvalId: "computer-use-approval-0",
              decision: { _tag: "request-app-grant", access: "observe" },
              target: { displayName: "TextEdit" },
              risk: "inspect",
            }
          : { observationId: "observation-1", target: { displayName: "TextEdit" } };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(T3_COMPUTER_USE_PI_EXTENSION_SOURCE).toString("base64")}#approval`;
  const extension = (await import(moduleUrl)) as {
    default: (pi: { registerTool: (tool: unknown) => void }) => void;
  };
  const tools: Array<{
    readonly name: string;
    readonly execute: (...args: Array<unknown>) => Promise<unknown>;
  }> = [];
  extension.default({ registerTool: (tool) => tools.push(tool as (typeof tools)[number]) });
  const select = vi.fn(async () => "Allow once");

  await expect(
    tools
      .find((tool) => tool.name === "computer_observe")!
      .execute("call-observe", { targetId: "target-1" }, new AbortController().signal, undefined, {
        hasUI: true,
        ui: { select },
      }),
  ).resolves.toMatchObject({ details: { observationId: "observation-1" } });
  expect(toolCalls).toBe(2);
  expect(select).toHaveBeenCalledWith(
    "T3 Computer Use [computer-use-approval-0] TextEdit :: observe",
    ["Allow once", "Allow for this session", "Always allow on this computer", "Deny"],
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
