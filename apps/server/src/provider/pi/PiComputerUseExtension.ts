/**
 * Dependency-free Pi/Atomic extension source. The adapter materializes this in
 * a private per-session temporary file so both CLIs receive the exact same MCP
 * transport without relying on either user's global extension installation.
 */
export const T3_COMPUTER_USE_PI_EXTENSION_SOURCE = String.raw`
const endpoint = process.env.T3CODE_MCP_ENDPOINT;
const authorization = process.env.T3CODE_MCP_AUTHORIZATION;
let nextRequestId = 1;
let mcpSessionId;
let mcpProtocolVersion;
let initializePromise;

const emptyObject = { type: "object", additionalProperties: false, properties: {} };
const targetId = { type: "string", minLength: 1, description: "Exact targetId from computer_list_targets." };
const observationId = { type: "string", minLength: 1, description: "Exact observationId from computer_observe or the preceding computer_act result." };
const point = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: { x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } },
};
const action = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["_tag", "x", "y"], properties: { _tag: { const: "click" }, x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "x", "y"], properties: { _tag: { const: "double-click" }, x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "x", "y"], properties: { _tag: { const: "secondary-click" }, x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "x", "y"], properties: { _tag: { const: "move" }, x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 }, durationMs: { type: "integer", minimum: 0, maximum: 60000 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "from", "to"], properties: { _tag: { const: "drag" }, from: point, to: point, durationMs: { type: "integer", minimum: 0, maximum: 60000 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "deltaX", "deltaY"], properties: { _tag: { const: "scroll" }, deltaX: { type: "number" }, deltaY: { type: "number" }, x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "text"], properties: { _tag: { enum: ["text-entry", "paste"] }, text: { type: "string", maxLength: 65536 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "key", "modifiers", "phase"], properties: { _tag: { const: "keypress" }, key: { type: "string", minLength: 1 }, modifiers: { type: "array", maxItems: 8, items: { enum: ["alt", "control", "meta", "shift", "fn"] } }, phase: { enum: ["press", "down", "up"] } } },
    { type: "object", additionalProperties: false, required: ["_tag", "elementId", "start", "end"], properties: { _tag: { const: "selection" }, elementId: { type: "string" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "elementId", "value"], properties: { _tag: { const: "direct-value" }, elementId: { type: "string" }, value: { type: "string", maxLength: 65536 } } },
    { type: "object", additionalProperties: false, required: ["_tag", "elementId", "action"], properties: { _tag: { const: "accessibility-action" }, elementId: { type: "string" }, action: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["_tag", "durationMs"], properties: { _tag: { const: "wait" }, durationMs: { type: "integer", minimum: 0, maximum: 60000 } } },
    { type: "object", additionalProperties: false, required: ["_tag"], properties: { _tag: { const: "screenshot-refresh" } } },
  ],
};

function responsePayload(text, contentType, requestId) {
  if (!text) return undefined;
  if (contentType.includes("text/event-stream")) {
    const messages = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    for (const line of messages) {
      const parsed = JSON.parse(line.slice(5).trim());
      if (requestId === undefined || parsed.id === requestId) return parsed;
    }
    return undefined;
  }
  return JSON.parse(text);
}

async function post(payload, signal) {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization,
    "content-type": "application/json",
  };
  if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
  if (mcpProtocolVersion) headers["mcp-protocol-version"] = mcpProtocolVersion;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal });
  const issuedSessionId = response.headers.get("mcp-session-id");
  if (issuedSessionId) mcpSessionId = issuedSessionId;
  const issuedProtocolVersion = response.headers.get("mcp-protocol-version");
  if (issuedProtocolVersion) mcpProtocolVersion = issuedProtocolVersion;
  const text = await response.text();
  if (!response.ok) throw new Error("T3 Code Computer Use transport failed with HTTP " + response.status + ".");
  const parsed = responsePayload(text, response.headers.get("content-type") || "", payload.id);
  if (parsed && parsed.error) {
    const code = typeof parsed.error.code === "number" ? " (" + parsed.error.code + ")" : "";
    throw new Error("T3 Code Computer Use request was rejected" + code + ".");
  }
  return parsed && parsed.result;
}

async function initialize(signal) {
  if (mcpSessionId) return;
  if (!initializePromise) {
    initializePromise = (async () => {
      const id = nextRequestId++;
      await post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t3-code-pi-computer-use", version: "1" } } }, signal);
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, signal);
    })().finally(() => { initializePromise = undefined; });
  }
  await initializePromise;
}

async function callTool(name, args, signal) {
  await initialize(signal);
  const id = nextRequestId++;
  return await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args || {} } }, signal);
}

const approvalOptions = {
  app: ["Allow once", "Allow for this session", "Always allow on this computer", "Deny"],
  action: ["Confirm action", "Deny"],
};

async function approvePolicyBoundary(boundary, signal, ctx) {
  if (!boundary || boundary._tag !== "policy" || !boundary.approvalId) return false;
  if (!ctx || !ctx.hasUI || !ctx.ui || typeof ctx.ui.select !== "function") return false;
  const isAppGrant = boundary.decision && boundary.decision._tag === "request-app-grant";
  const isActionConfirmation = boundary.decision && boundary.decision._tag === "request-action-confirmation";
  if (!isAppGrant && !isActionConfirmation) return false;
  const displayName = boundary.target && boundary.target.displayName ? boundary.target.displayName : "this app";
  const approvalKind = isAppGrant ? boundary.decision.access : boundary.decision.risk;
  const selected = await ctx.ui.select(
    "T3 Computer Use [" + boundary.approvalId + "] " + displayName + " :: " + approvalKind,
    isAppGrant ? approvalOptions.app : approvalOptions.action,
    { signal },
  );
  return selected !== undefined && selected !== "Deny";
}

const definitions = [
  { name: "computer_status", label: "Get computer status", description: "Report T3 native Computer Use host availability, lock state, and OS permissions.", parameters: emptyObject },
  { name: "computer_list_targets", label: "List computer targets", description: "List native application and window targets. T3 Code and terminal apps are forbidden.", parameters: { type: "object", additionalProperties: false, properties: { kind: { enum: ["application", "window", "browser-tab", "office-document"] } } } },
  { name: "computer_observe", label: "Observe computer target", description: "Observe one exact target before acting. Returns accessibility state, an observation ID, and optionally a screenshot. App access is governed by T3.", parameters: { type: "object", additionalProperties: false, required: ["targetId"], properties: { targetId, includeScreenshot: { type: "boolean" }, includeAccessibility: { type: "boolean" } } } },
  { name: "computer_act", label: "Operate computer target", description: "Perform a bounded action batch against one exact target and fresh observation. T3 classifies risk and enforces grants and point-of-risk confirmation.", parameters: { type: "object", additionalProperties: false, required: ["targetId", "observationId", "actions"], properties: { targetId, observationId, actions: { type: "array", minItems: 1, maxItems: 64, items: action } } } },
  { name: "computer_stop", label: "Stop computer use", description: "Immediately release this turn's Computer Use control lease.", parameters: emptyObject },
];

export default function t3ComputerUseExtension(pi) {
  if (!endpoint || !authorization) return;
  for (const definition of definitions) {
    pi.registerTool({
      ...definition,
      promptSnippet: "Use " + definition.name + " only for user-authorized native computer interaction through T3 Code.",
      executionMode: "sequential",
      async execute(_toolCallId, args, signal, _onUpdate, ctx) {
        let result = await callTool(definition.name, args, signal);
        const boundary = result && result.structuredContent;
        if (await approvePolicyBoundary(boundary, signal, ctx)) {
          result = await callTool(definition.name, args, signal);
        }
        const content = Array.isArray(result && result.content)
          ? result.content
          : [{ type: "text", text: JSON.stringify(result && result.structuredContent ? result.structuredContent : {}) }];
        return {
          content,
          details: result && result.structuredContent ? result.structuredContent : {},
          isError: Boolean(result && result.isError),
        };
      },
    });
  }
}
`;
