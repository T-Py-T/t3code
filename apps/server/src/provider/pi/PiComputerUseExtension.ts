/**
 * Dependency-free Pi/Atomic extension source. The adapter materializes this in
 * a private per-session temporary file so both CLIs receive the exact same MCP
 * transport without relying on either user's global extension installation.
 */
export const T3_COMPUTER_USE_PI_EXTENSION_SOURCE = String.raw`
import { pathToFileURL } from "node:url";

const endpoint = process.env.T3CODE_MCP_ENDPOINT;
const authorization = process.env.T3CODE_MCP_AUTHORIZATION;
const enabledCapabilities = new Set(
  (process.env.T3CODE_MCP_CAPABILITIES || "computer,preview")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
let nextRequestId = 1;
let mcpSessionId;
let mcpProtocolVersion;
let initializePromise;

const emptyObject = { type: "object", additionalProperties: false, properties: {} };
const targetId = { type: "string", minLength: 1, description: "Exact targetId from computer_list_targets." };
const observationId = { type: "string", minLength: 1, description: "Exact observationId from computer_observe or the preceding computer_act result." };
const actionRisk = { enum: ["inspect", "reversible-local", "external-side-effect", "sensitive-data", "destructive-or-privileged", "forbidden"], description: "Intended semantic consequence. Declare sensitive, destructive, privileged, or forbidden intent so T3 can apply stronger protection. This can only raise T3's server-owned risk floor." };
const tabId = { type: "string", minLength: 1, maxLength: 128, description: "Exact collaborative browser tab ID. Omit to use this agent session's current tab." };
const browser = { enum: ["built-in", "external"], description: "Browser surface. Defaults to built-in; external uses the explicitly enabled persistent T3 Code profile for signed-in sites." };
const timeoutMs = { type: "integer", minimum: 1, maximum: 60000, description: "Maximum wait in milliseconds." };
const locator = { type: "string", minLength: 1, description: "Prefer a semantic Playwright locator such as role=button[name='Send']." };
const selector = { type: "string", minLength: 1, description: "Legacy CSS selector. Prefer locator." };
const browserTabProperties = { browser, tabId };
const browserTargetProperties = { ...browserTabProperties, locator, selector };
const objectParameters = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  properties,
});
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

function workflowContext(ctx) {
  const candidates = [ctx, ctx && ctx.workflow, ctx && ctx.metadata].filter(Boolean);
  const runId = candidates.map((value) => value.workflowRunId || value.runId).find((value) => typeof value === "string" && value.length > 0 && value.length <= 512);
  const stageId = candidates.map((value) => value.workflowStageId || value.stageId).find((value) => typeof value === "string" && value.length > 0 && value.length <= 512);
  return { runId, stageId };
}

async function post(payload, signal, ctx) {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization,
    "content-type": "application/json",
  };
  const workflow = workflowContext(ctx);
  if (workflow.runId) headers["x-t3-workflow-run-id"] = workflow.runId;
  if (workflow.stageId) headers["x-t3-workflow-stage-id"] = workflow.stageId;
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

async function initialize(signal, ctx) {
  if (mcpSessionId) return;
  if (!initializePromise) {
    initializePromise = (async () => {
      const id = nextRequestId++;
      await post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t3-code-pi-computer-use", version: "1" } } }, signal, ctx);
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, signal, ctx);
    })().finally(() => { initializePromise = undefined; });
  }
  await initializePromise;
}

async function callTool(name, args, signal, ctx) {
  await initialize(signal, ctx);
  const id = nextRequestId++;
  return await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args || {} } }, signal, ctx);
}

const approvalOptions = {
  app: ["Allow once", "Allow for this turn", "Allow for this session", "Always allow on this computer", "Deny"],
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
  const actionSummary = boundary.action && boundary.action.summary ? " -- " + boundary.action.summary : "";
  const selected = await ctx.ui.select(
    "T3 Computer Use [" + boundary.approvalId + "] " + displayName + " :: " + approvalKind + actionSummary,
    isAppGrant ? approvalOptions.app : approvalOptions.action,
    { signal },
  );
  return selected !== undefined && selected !== "Deny";
}

const definitions = [
  { capability: "computer", name: "computer_status", label: "Get computer status", description: "Report T3 native Computer Use host availability, lock state, and OS permissions.", parameters: emptyObject },
  { capability: "computer", name: "computer_list_targets", label: "List computer targets", description: "List native application, window, and structured Office document targets. Targets report their strongest available integration and supported operations. Prefer office-document targets for Excel and PowerPoint. T3 Code and terminal apps are forbidden.", parameters: objectParameters({ kind: { enum: ["application", "window", "browser-tab", "office-document"] } }) },
  { capability: "computer", name: "computer_observe", label: "Observe computer target", description: "Observe one exact target before acting. Returns accessibility state, an observation ID, and optionally a screenshot. App access is governed by T3.", parameters: objectParameters({ targetId, includeScreenshot: { type: "boolean" }, includeAccessibility: { type: "boolean" } }, ["targetId"]) },
  { capability: "computer", name: "computer_act", label: "Operate computer target", description: "Perform a bounded action batch against one exact target and fresh observation. Declare the intended semantic risk when it exceeds the primitive action risk. T3 enforces a server-owned floor, grants, confirmation, and takeover.", parameters: objectParameters({ targetId, observationId, actions: { type: "array", minItems: 1, maxItems: 64, items: action }, risk: actionRisk }, ["targetId", "observationId", "actions"]) },
  { capability: "computer", name: "computer_stop", label: "Stop computer use", description: "Immediately release this turn's Computer Use control lease.", parameters: emptyObject },
  { capability: "preview", name: "preview_status", label: "Get browser status", description: "Report the current collaborative browser tab, URL, title, visibility, loading state, and viewport.", parameters: objectParameters(browserTabProperties) },
  { capability: "preview", name: "preview_open", label: "Open browser preview", description: "Open or reuse a thread-bound semantic browser tab. The tab can be visible to the user or run in the background.", parameters: objectParameters({ ...browserTabProperties, url: { type: "string", maxLength: 2048 }, open: { type: "boolean" }, show: { type: "boolean" }, reuseExistingTab: { type: "boolean" } }) },
  { capability: "preview", name: "preview_navigate", label: "Navigate browser preview", description: "Navigate the semantic browser to one public URL or an environment-relative development server.", parameters: objectParameters({ ...browserTabProperties, url: { type: "string", maxLength: 2048 }, target: { oneOf: [{ type: "object", additionalProperties: false, required: ["kind", "url"], properties: { kind: { const: "url" }, url: { type: "string", maxLength: 2048 } } }, { type: "object", additionalProperties: false, required: ["kind", "port"], properties: { kind: { const: "environment-port" }, port: { type: "integer", minimum: 1, maximum: 65535 }, protocol: { enum: ["http", "https"] }, path: { type: "string" } } }] }, readiness: { enum: ["load", "domContentLoaded", "none"] }, timeoutMs }) },
  { capability: "preview", name: "preview_resize", label: "Resize browser viewport", description: "Resize the semantic browser using fill, freeform dimensions, or a named device preset.", parameters: objectParameters({ ...browserTabProperties, mode: { enum: ["fill", "freeform", "preset"] }, preset: { type: "string" }, width: { type: "integer", minimum: 240, maximum: 3840 }, height: { type: "integer", minimum: 240, maximum: 3840 }, orientation: { enum: ["portrait", "landscape"] }, timeoutMs }, ["mode"]) },
  { capability: "preview", name: "preview_set_appearance", label: "Set browser appearance", description: "Emulate light, dark, or system color scheme in the semantic browser.", parameters: objectParameters({ ...browserTabProperties, colorScheme: { enum: ["system", "light", "dark"] } }, ["colorScheme"]) },
  { capability: "preview", name: "preview_snapshot", label: "Inspect browser page", description: "Return a semantic page snapshot, diagnostics, action history, and screenshot before interacting.", parameters: objectParameters(browserTabProperties) },
  { capability: "preview", name: "preview_click", label: "Click browser page", description: "Click one semantic locator, CSS selector, or viewport coordinate pair in the browser.", parameters: objectParameters({ ...browserTargetProperties, x: { type: "number" }, y: { type: "number" }, timeoutMs }) },
  { capability: "preview", name: "preview_type", label: "Type into browser page", description: "Insert literal text into a semantic locator, CSS selector, or the focused browser element.", parameters: objectParameters({ ...browserTargetProperties, text: { type: "string" }, clear: { type: "boolean" }, timeoutMs }, ["text"]) },
  { capability: "preview", name: "preview_press", label: "Press browser key", description: "Press one key with optional modifiers in the semantic browser.", parameters: objectParameters({ ...browserTabProperties, key: { type: "string", minLength: 1 }, modifiers: { type: "array", maxItems: 4, items: { enum: ["Alt", "Control", "Meta", "Shift"] } } }, ["key"]) },
  { capability: "preview", name: "preview_scroll", label: "Scroll browser page", description: "Scroll the browser viewport or a semantic locator/selector container.", parameters: objectParameters({ ...browserTargetProperties, deltaX: { type: "number" }, deltaY: { type: "number" } }) },
  { capability: "preview", name: "preview_evaluate", label: "Evaluate browser JavaScript", description: "Evaluate bounded JavaScript in the page when semantic actions cannot express the operation.", parameters: objectParameters({ ...browserTabProperties, expression: { type: "string", minLength: 1, maxLength: 64000 }, awaitPromise: { type: "boolean" }, returnByValue: { type: "boolean" } }, ["expression"]) },
  { capability: "preview", name: "preview_wait_for", label: "Wait for browser page", description: "Wait until all supplied semantic locator, selector, text, and URL conditions match.", parameters: objectParameters({ ...browserTargetProperties, text: { type: "string", minLength: 1 }, urlIncludes: { type: "string", minLength: 1 }, timeoutMs }) },
  { capability: "preview", name: "preview_recording_start", label: "Start browser recording", description: "Start recording the current collaborative browser tab for visible test evidence.", parameters: objectParameters(browserTabProperties) },
  { capability: "preview", name: "preview_recording_stop", label: "Stop browser recording", description: "Stop browser recording and save the result as a local evidence artifact.", parameters: objectParameters(browserTabProperties) },
];

const workflowControlActions = new Set([
  "status",
  "stages",
  "stage",
  "transcript",
  "send",
  "pause",
  "resume",
  "interrupt",
  "quit",
  "reload",
]);
let executeWorkflowAction;

async function loadWorkflowExecutor(pi) {
  if (executeWorkflowAction) return executeWorkflowAction;
  if (typeof pi.getAllTools !== "function") throw new Error("Atomic workflow tools are unavailable.");
  const workflowTool = pi.getAllTools().find((entry) => entry && entry.name === "workflow");
  const sourceInfo = workflowTool && workflowTool.sourceInfo;
  const bundlePath = sourceInfo && sourceInfo.path;
  const normalizedBundlePath = typeof bundlePath === "string" ? bundlePath.replaceAll("\\", "/") : "";
  if (
    typeof bundlePath !== "string" ||
    sourceInfo.configurationOrigin !== "bundled" ||
    !normalizedBundlePath.includes("/builtin/workflows/") ||
    !normalizedBundlePath.endsWith("/index.bundle.mjs")
  ) {
    throw new Error("Atomic's bundled workflow controller is unavailable.");
  }
  const workflowModule = await import(pathToFileURL(bundlePath).href);
  if (typeof workflowModule.default !== "function") {
    throw new Error("Atomic's bundled workflow controller is incompatible.");
  }
  const registrationProxy = new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (definition) => {
          if (definition && definition.name === "workflow") {
            executeWorkflowAction = definition.execute;
          }
        };
      }
      if (
        property === "registerCommand" ||
        property === "registerMessageRenderer" ||
        property === "registerShortcut" ||
        property === "on"
      ) {
        return () => undefined;
      }
      if (property === "ui" || property === "events") return undefined;
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  workflowModule.default(registrationProxy);
  if (typeof executeWorkflowAction !== "function") {
    throw new Error("Atomic's bundled workflow executor could not be captured.");
  }
  return executeWorkflowAction;
}

async function emitWorkflowActionResult(pi, envelope, result) {
  if (typeof pi.sendMessage !== "function") return;
  await pi.sendMessage(
    {
      customType: "t3:workflow-action",
      content: "",
      display: false,
      details: {
        actionId: envelope.actionId,
        request: envelope.request,
        result,
      },
    },
    { triggerTurn: false, excludeFromContext: true },
  );
}

function registerWorkflowControlBridge(pi) {
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("t3-workflow-action", {
    description: "Private T3 Code bridge for Atomic workflow inspection and control.",
    async handler(encoded, ctx) {
      let envelope;
      try {
        envelope = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8"));
        if (
          !envelope ||
          typeof envelope.actionId !== "string" ||
          !envelope.request ||
          !workflowControlActions.has(envelope.request.action)
        ) {
          throw new Error("Invalid T3 workflow action.");
        }
        const execute = await loadWorkflowExecutor(pi);
        const output = await execute(
          "t3-workflow-action-" + envelope.actionId,
          envelope.request,
          undefined,
          undefined,
          ctx,
        );
        await emitWorkflowActionResult(pi, envelope, output && output.details ? output.details : {});
      } catch (error) {
        const fallback = envelope && typeof envelope.actionId === "string"
          ? envelope
          : { actionId: "invalid", request: {} };
        await emitWorkflowActionResult(pi, fallback, {
          action: "t3_bridge_error",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}

export default function t3ComputerUseExtension(pi) {
  registerWorkflowControlBridge(pi);
  if (endpoint && authorization) {
    for (const definition of definitions) {
      if (!enabledCapabilities.has(definition.capability)) continue;
      const { capability, ...toolDefinition } = definition;
      pi.registerTool({
        ...toolDefinition,
        promptSnippet: capability === "preview"
          ? "Use " + toolDefinition.name + " for user-authorized semantic browser interaction through T3 Code. Prefer this route over native coordinates for web pages. Pass browser='external' only when a signed-in site is required and the user enabled the dedicated T3 browser profile."
          : "Use " + toolDefinition.name + " only for user-authorized native computer interaction through T3 Code.",
        executionMode: "sequential",
        async execute(_toolCallId, args, signal, _onUpdate, ctx) {
          let result = await callTool(definition.name, args, signal, ctx);
          let previousApprovalId;
          for (let approvalCount = 0; approvalCount < 4; approvalCount += 1) {
            const boundary = result && result.structuredContent;
            if (!boundary || boundary.approvalId === previousApprovalId) break;
            if (!(await approvePolicyBoundary(boundary, signal, ctx))) break;
            previousApprovalId = boundary.approvalId;
            result = await callTool(definition.name, args, signal, ctx);
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
}
`;
