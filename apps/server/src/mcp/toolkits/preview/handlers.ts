import * as Effect from "effect/Effect";
import type {
  ComputerUseActionRisk,
  ComputerUseHistoryOperation,
  ComputerUseTarget,
  PreviewAutomationOperation,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";
import {
  ComputerUseHostId,
  ComputerUseRequestIdentity,
  ComputerUseTargetId,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ComputerUseToolkit from "../../../computerUse/ComputerUseToolkit.ts";
import { resolvePolicyBoundary } from "../computer/handlers.ts";
import * as Crypto from "effect/Crypto";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const browserOrigin = (url: string | null): string => {
  if (!url) return "about:blank";
  try {
    return new URL(url).origin;
  } catch {
    return "opaque-origin";
  }
};

/**
 * Collapses the `show` alias onto `open` and defaults tab reuse.
 *
 * Deliberately leaves an unstated `open` unstated. Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  if (scope.turnId === undefined) {
    return yield* new PreviewAutomationUnavailableError({
      capability: "preview",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      providerSessionId: scope.providerSessionId,
      providerInstanceId: scope.providerInstanceId,
    });
  }
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const toolkit = yield* ComputerUseToolkit.ComputerUseToolkit;
  const crypto = yield* Crypto.Crypto;
  const details = typeof input === "object" && input !== null ? input : {};
  const browser = "browser" in details && details.browser === "external" ? "external" : "built-in";
  const displayName = browser === "external" ? "External browser" : "Built-in browser";
  const externalStatus =
    browser === "external"
      ? yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: { browser: "external" },
          ...(tabId === undefined ? {} : { tabId }),
        })
      : undefined;
  const profileId = externalStatus?.profileId;
  if (browser === "external" && !profileId) {
    return yield* new PreviewAutomationUnavailableError({
      capability: "preview",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      providerSessionId: scope.providerSessionId,
      providerInstanceId: scope.providerInstanceId,
    });
  }
  const policyIdentitySeed =
    browser === "external"
      ? {
          profileId,
          tabId: tabId ?? externalStatus?.tabId ?? "new-tab",
          destination:
            operation === "open" || operation === "navigate"
              ? {
                  url: "url" in details && typeof details.url === "string" ? details.url : null,
                  target: "target" in details ? details.target : null,
                }
              : browserOrigin(externalStatus?.url ?? null),
        }
      : { browser };
  const policyIdentityDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(encodeUnknownJsonString(policyIdentitySeed)))
    .pipe(Effect.orDie, Effect.map(Encoding.encodeHex));
  const target: ComputerUseTarget = {
    targetId: ComputerUseTargetId.make(`preview-${browser}`),
    kind: "browser-tab",
    displayName:
      browser === "external"
        ? `${displayName} — ${browserOrigin(externalStatus?.url ?? null)}`
        : displayName,
    applicationId:
      browser === "external" ? `t3.preview.external.${profileId}` : "t3.preview.built-in",
    stableIdentity:
      browser === "external" ? `preview:external:${policyIdentityDigest}` : "preview:built-in",
  };
  const access =
    operation === "status" || operation === "snapshot" || operation === "waitFor"
      ? ("observe" as const)
      : ("operate" as const);
  const risk: ComputerUseActionRisk =
    access === "observe"
      ? "inspect"
      : operation === "resize" ||
          operation === "setColorScheme" ||
          operation === "scroll" ||
          operation === "recordingStart" ||
          operation === "recordingStop"
        ? "reversible-local"
        : "external-side-effect";
  const actionTarget =
    "locator" in details && typeof details.locator === "string"
      ? "the requested semantic target"
      : "selector" in details && typeof details.selector === "string"
        ? "the requested page element"
        : "x" in details && "y" in details
          ? `coordinates (${String(details.x)}, ${String(details.y)})`
          : "the active page";
  const requestedUrl = (() => {
    if (!("url" in details) || typeof details.url !== "string") return "the requested page";
    try {
      return new URL(details.url).origin;
    } catch {
      return "the requested page";
    }
  })();
  const actionSummary = (() => {
    switch (operation) {
      case "open":
      case "navigate":
        return `${operation === "open" ? "Open" : "Navigate to"} ${requestedUrl}`;
      case "click":
        return `Click ${actionTarget}`;
      case "type":
        return `Type ${"text" in details && typeof details.text === "string" ? details.text.length : 0} characters into ${actionTarget}`;
      case "press":
        return "Press a browser key";
      case "evaluate":
        return `Evaluate browser JavaScript (${"expression" in details && typeof details.expression === "string" ? details.expression.length : 0} characters)`;
      case "scroll":
        return `Scroll ${actionTarget}`;
      default:
        return `${operation} ${displayName}`;
    }
  })();
  const redactedActionSummary = actionSummary.slice(0, 512);
  const digest = yield* crypto
    .digest(
      "SHA-256",
      new TextEncoder().encode(encodeUnknownJsonString({ operation, input, tabId: tabId ?? null })),
    )
    .pipe(Effect.orDie);
  const computerScope = {
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId: scope.providerInstanceId,
  };
  const outcome = yield* resolvePolicyBoundary(
    toolkit,
    toolkit.executeGoverned(
      {
        scope: computerScope,
        hostId: ComputerUseHostId.make(
          browser === "external"
            ? `preview-${scope.environmentId}-${policyIdentityDigest}`
            : `preview-${scope.environmentId}`,
        ),
        operation: `browser-${operation}` as ComputerUseHistoryOperation,
        target,
        access,
        risk,
        runtimeMode: scope.runtimeMode ?? "full-access",
        action: {
          requestIdentity: ComputerUseRequestIdentity.make(Encoding.encodeHex(digest)),
          summary: redactedActionSummary,
        },
        requestedSummary: `Requested ${redactedActionSummary}.`,
        activeSummary: `${redactedActionSummary}.`,
        completedSummary: `Completed ${redactedActionSummary}.`,
      },
      broker.invoke<A>({
        scope,
        operation,
        input,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(tabId === undefined ? {} : { tabId }),
      }),
    ),
  );
  return outcome._tag === "success" ? outcome.value : outcome;
});

const invokeTargeted = <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId);
};

const emptyActionResult = (
  result: void | ComputerUseToolkit.ComputerUsePolicyBoundary,
): Record<string, never> | ComputerUseToolkit.ComputerUsePolicyBoundary =>
  result && result._tag === "policy" ? result : {};

const handlers = {
  preview_status: (input) => invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  preview_open: (input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  preview_navigate: (input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_resize: (input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  preview_snapshot: (input) => invokeTargeted<PreviewAutomationSnapshot>("snapshot", input ?? {}),
  preview_click: (input) =>
    invokeTargeted<void>("click", input, input.timeoutMs).pipe(Effect.map(emptyActionResult)),
  preview_type: (input) =>
    invokeTargeted<void>("type", input, input.timeoutMs).pipe(Effect.map(emptyActionResult)),
  preview_press: (input) =>
    invokeTargeted<void>("press", input).pipe(Effect.map(emptyActionResult)),
  preview_scroll: (input) =>
    invokeTargeted<void>("scroll", input).pipe(Effect.map(emptyActionResult)),
  preview_evaluate: (input) =>
    invokeTargeted<unknown>("evaluate", input).pipe(Effect.map((result) => result ?? null)),
  preview_wait_for: (input) =>
    invokeTargeted<void>("waitFor", input, input.timeoutMs).pipe(Effect.map(emptyActionResult)),
  preview_recording_start: (input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  preview_recording_stop: (input) =>
    invokeTargeted<PreviewAutomationRecordingArtifact>("recordingStop", input ?? {}),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
});

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers);
