import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const makeComputerUseId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ComputerUseHostId = makeComputerUseId("ComputerUseHostId");
export type ComputerUseHostId = typeof ComputerUseHostId.Type;
export const ComputerUseConnectionId = makeComputerUseId("ComputerUseConnectionId");
export type ComputerUseConnectionId = typeof ComputerUseConnectionId.Type;
export const ComputerUseLeaseId = makeComputerUseId("ComputerUseLeaseId");
export type ComputerUseLeaseId = typeof ComputerUseLeaseId.Type;
export const ComputerUseRequestId = makeComputerUseId("ComputerUseRequestId");
export type ComputerUseRequestId = typeof ComputerUseRequestId.Type;
export const ComputerUseTargetId = makeComputerUseId("ComputerUseTargetId");
export type ComputerUseTargetId = typeof ComputerUseTargetId.Type;
export const ComputerUseObservationId = makeComputerUseId("ComputerUseObservationId");
export type ComputerUseObservationId = typeof ComputerUseObservationId.Type;

export const ComputerUseTargetKind = Schema.Literals([
  "application",
  "window",
  "browser-tab",
  "office-document",
]);
export type ComputerUseTargetKind = typeof ComputerUseTargetKind.Type;

export const ComputerUseTarget = Schema.Struct({
  targetId: ComputerUseTargetId,
  kind: ComputerUseTargetKind,
  displayName: TrimmedNonEmptyString,
  applicationId: TrimmedNonEmptyString,
  stableIdentity: TrimmedNonEmptyString,
});
export type ComputerUseTarget = typeof ComputerUseTarget.Type;

export const ComputerUseAccessLevel = Schema.Literals(["observe", "operate"]);
export type ComputerUseAccessLevel = typeof ComputerUseAccessLevel.Type;

export const ComputerUseGrantDuration = Schema.Literals([
  "one-action",
  "turn",
  "session",
  "persistent",
]);
export type ComputerUseGrantDuration = typeof ComputerUseGrantDuration.Type;

export const ComputerUseActionRisk = Schema.Literals([
  "inspect",
  "reversible-local",
  "external-side-effect",
  "sensitive-data",
  "destructive-or-privileged",
  "forbidden",
]);
export type ComputerUseActionRisk = typeof ComputerUseActionRisk.Type;

export const ComputerUsePolicyDecision = Schema.Union([
  Schema.TaggedStruct("allow", {}),
  Schema.TaggedStruct("request-app-grant", {
    access: ComputerUseAccessLevel,
  }),
  Schema.TaggedStruct("request-action-confirmation", {
    risk: ComputerUseActionRisk,
  }),
  Schema.TaggedStruct("require-takeover", {
    risk: ComputerUseActionRisk,
  }),
  Schema.TaggedStruct("deny", {
    reason: Schema.Literals(["forbidden-action", "forbidden-target", "identity-changed"]),
  }),
]);
export type ComputerUsePolicyDecision = typeof ComputerUsePolicyDecision.Type;

export const ComputerUsePlatform = Schema.Literals(["macos", "windows"]);
export type ComputerUsePlatform = typeof ComputerUsePlatform.Type;

export const COMPUTER_USE_OPERATIONS = ["status", "listTargets", "observe", "act"] as const;
export const ComputerUseOperation = Schema.Literals(COMPUTER_USE_OPERATIONS);
export type ComputerUseOperation = typeof ComputerUseOperation.Type;

export const COMPUTER_USE_MAX_ACTIONS_PER_BATCH = 64;
export const COMPUTER_USE_MAX_TEXT_LENGTH = 65_536;
export const COMPUTER_USE_MAX_TIMEOUT_MS = 120_000;
export const COMPUTER_USE_MAX_SCREENSHOT_BASE64_LENGTH = 11_184_812;
export const COMPUTER_USE_MAX_ACCESSIBILITY_ELEMENTS = 5_000;

const ComputerUseCoordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 65_535 }),
);
const ComputerUseDelta = Schema.Finite.check(
  Schema.isBetween({ minimum: -65_535, maximum: 65_535 }),
);
const ComputerUseDurationMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }));
const ComputerUseDimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const ComputerUseText = Schema.String.check(Schema.isMaxLength(COMPUTER_USE_MAX_TEXT_LENGTH));
const ComputerUseShortString = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const ComputerUsePoint = Schema.Struct({
  x: ComputerUseCoordinate,
  y: ComputerUseCoordinate,
});
export type ComputerUsePoint = typeof ComputerUsePoint.Type;

export const ComputerUseKeyModifier = Schema.Literals(["alt", "control", "meta", "shift", "fn"]);
export type ComputerUseKeyModifier = typeof ComputerUseKeyModifier.Type;

export const ComputerUseAction = Schema.Union([
  Schema.TaggedStruct("click", {
    x: ComputerUseCoordinate,
    y: ComputerUseCoordinate,
  }),
  Schema.TaggedStruct("double-click", {
    x: ComputerUseCoordinate,
    y: ComputerUseCoordinate,
  }),
  Schema.TaggedStruct("secondary-click", {
    x: ComputerUseCoordinate,
    y: ComputerUseCoordinate,
  }),
  Schema.TaggedStruct("move", {
    x: ComputerUseCoordinate,
    y: ComputerUseCoordinate,
    durationMs: Schema.optional(ComputerUseDurationMs),
  }),
  Schema.TaggedStruct("drag", {
    from: ComputerUsePoint,
    to: ComputerUsePoint,
    durationMs: Schema.optional(ComputerUseDurationMs),
  }),
  Schema.TaggedStruct("scroll", {
    deltaX: ComputerUseDelta,
    deltaY: ComputerUseDelta,
    x: Schema.optional(ComputerUseCoordinate),
    y: Schema.optional(ComputerUseCoordinate),
  }),
  Schema.TaggedStruct("text-entry", {
    text: ComputerUseText,
  }),
  Schema.TaggedStruct("paste", {
    text: ComputerUseText,
  }),
  Schema.TaggedStruct("keypress", {
    key: ComputerUseShortString,
    modifiers: Schema.Array(ComputerUseKeyModifier).check(Schema.isMaxLength(8)),
    phase: Schema.Literals(["press", "down", "up"]),
  }),
  Schema.TaggedStruct("selection", {
    elementId: ComputerUseShortString,
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
  Schema.TaggedStruct("direct-value", {
    elementId: ComputerUseShortString,
    value: ComputerUseText,
  }),
  Schema.TaggedStruct("accessibility-action", {
    elementId: ComputerUseShortString,
    action: ComputerUseShortString,
  }),
  Schema.TaggedStruct("wait", {
    durationMs: ComputerUseDurationMs,
  }),
  Schema.TaggedStruct("screenshot-refresh", {}),
]);
export type ComputerUseAction = typeof ComputerUseAction.Type;

export const ComputerUseActionBatch = Schema.Struct({
  actions: Schema.Array(ComputerUseAction).check(
    Schema.isLengthBetween(1, COMPUTER_USE_MAX_ACTIONS_PER_BATCH),
  ),
});
export type ComputerUseActionBatch = typeof ComputerUseActionBatch.Type;

export const ComputerUseScreenshot = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  base64: Schema.String.check(Schema.isMaxLength(COMPUTER_USE_MAX_SCREENSHOT_BASE64_LENGTH)),
  width: ComputerUseDimension,
  height: ComputerUseDimension,
});
export type ComputerUseScreenshot = typeof ComputerUseScreenshot.Type;

export const ComputerUseAccessibilityElement = Schema.Struct({
  elementId: ComputerUseShortString,
  role: ComputerUseShortString,
  name: Schema.optional(ComputerUseText),
  value: Schema.optional(ComputerUseText),
  enabled: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  frame: Schema.optional(
    Schema.Struct({
      x: ComputerUseCoordinate,
      y: ComputerUseCoordinate,
      width: ComputerUseDimension,
      height: ComputerUseDimension,
    }),
  ),
  actions: Schema.optional(Schema.Array(ComputerUseShortString).check(Schema.isMaxLength(64))),
});
export type ComputerUseAccessibilityElement = typeof ComputerUseAccessibilityElement.Type;

export const ComputerUseObservation = Schema.Struct({
  observationId: ComputerUseObservationId,
  target: ComputerUseTarget,
  capturedAt: Schema.String,
  width: ComputerUseDimension,
  height: ComputerUseDimension,
  screenshot: Schema.optional(ComputerUseScreenshot),
  elements: Schema.Array(ComputerUseAccessibilityElement).check(
    Schema.isMaxLength(COMPUTER_USE_MAX_ACCESSIBILITY_ELEMENTS),
  ),
});
export type ComputerUseObservation = typeof ComputerUseObservation.Type;

export const ComputerUseActResult = Schema.Struct({
  completedActions: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(COMPUTER_USE_MAX_ACTIONS_PER_BATCH),
  ),
  observation: ComputerUseObservation,
});
export type ComputerUseActResult = typeof ComputerUseActResult.Type;

export const ComputerUsePermissionState = Schema.Literals([
  "granted",
  "denied",
  "not-determined",
  "not-required",
]);
export type ComputerUsePermissionState = typeof ComputerUsePermissionState.Type;

export const ComputerUseHostStatus = Schema.Struct({
  locked: Schema.Boolean,
  permissions: Schema.Struct({
    accessibility: ComputerUsePermissionState,
    screenCapture: ComputerUsePermissionState,
    input: ComputerUsePermissionState,
  }),
  foregroundTargetId: Schema.optional(ComputerUseTargetId),
});
export type ComputerUseHostStatus = typeof ComputerUseHostStatus.Type;

export const ComputerUseTargetList = Schema.Struct({
  targets: Schema.Array(ComputerUseTarget).check(Schema.isMaxLength(512)),
});
export type ComputerUseTargetList = typeof ComputerUseTargetList.Type;

export const ComputerUseStopReason = Schema.Literals([
  "user",
  "takeover",
  "interrupted",
  "turn-completed",
  "session-stopped",
  "host-disconnected",
]);
export type ComputerUseStopReason = typeof ComputerUseStopReason.Type;

export const ComputerUseVerifiedIdentity = Schema.Struct({
  subject: TrimmedNonEmptyString,
  publisher: TrimmedNonEmptyString,
});
export type ComputerUseVerifiedIdentity = typeof ComputerUseVerifiedIdentity.Type;

/**
 * A host descriptor accepted only after the local bootstrap verifies the
 * platform signature. Decoding this shape is not itself proof of identity.
 */
export const ComputerUseVerifiedHost = Schema.Struct({
  hostId: ComputerUseHostId,
  environmentId: EnvironmentId,
  platform: ComputerUsePlatform,
  protocolVersion: Schema.Literal(1),
  supportedOperations: Schema.Array(ComputerUseOperation),
  verifiedIdentity: ComputerUseVerifiedIdentity,
});
export type ComputerUseVerifiedHost = typeof ComputerUseVerifiedHost.Type;

export const ComputerUseStatus = Schema.Struct({
  host: ComputerUseVerifiedHost,
  status: ComputerUseHostStatus,
});
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

const ComputerUseHostRequestFields = {
  requestId: ComputerUseRequestId,
  leaseId: ComputerUseLeaseId,
  environmentId: EnvironmentId,
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: COMPUTER_USE_MAX_TIMEOUT_MS }),
  ),
};

export const ComputerUseHostRequest = Schema.Union([
  Schema.Struct({
    ...ComputerUseHostRequestFields,
    operation: Schema.Literal("status"),
    input: Schema.Struct({}),
  }),
  Schema.Struct({
    ...ComputerUseHostRequestFields,
    operation: Schema.Literal("listTargets"),
    input: Schema.Struct({
      kind: Schema.optional(ComputerUseTargetKind),
    }),
  }),
  Schema.Struct({
    ...ComputerUseHostRequestFields,
    operation: Schema.Literal("observe"),
    targetId: ComputerUseTargetId,
    input: Schema.Struct({
      includeScreenshot: Schema.optional(Schema.Boolean),
      includeAccessibility: Schema.optional(Schema.Boolean),
    }),
  }),
  Schema.Struct({
    ...ComputerUseHostRequestFields,
    operation: Schema.Literal("act"),
    targetId: ComputerUseTargetId,
    observationId: ComputerUseObservationId,
    input: ComputerUseActionBatch,
  }),
]);
export type ComputerUseHostRequest = typeof ComputerUseHostRequest.Type;

export const ComputerUseHostStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: ComputerUseConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: ComputerUseConnectionId,
    request: ComputerUseHostRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    connectionId: ComputerUseConnectionId,
    leaseId: ComputerUseLeaseId,
    reason: ComputerUseStopReason,
  }),
]);
export type ComputerUseHostStreamEvent = typeof ComputerUseHostStreamEvent.Type;

export const ComputerUseHostFailureTag = Schema.Literals([
  "ComputerUsePermissionMissingError",
  "ComputerUseTargetNotFoundError",
  "ComputerUseTargetIdentityChangedError",
  "ComputerUseStaleObservationError",
  "ComputerUseUnsupportedOperationError",
  "ComputerUsePolicyDeniedError",
  "ComputerUseApprovalRequiredError",
  "ComputerUseConfirmationRequiredError",
  "ComputerUseTargetClosedError",
  "ComputerUseLockStateChangedError",
  "ComputerUseHumanInputDetectedError",
  "ComputerUseTakeoverError",
  "ComputerUseInterruptedError",
  "ComputerUseTimeoutError",
  "ComputerUseMalformedResponseError",
  "ComputerUseHostDisconnectedError",
]);
export type ComputerUseHostFailureTag = typeof ComputerUseHostFailureTag.Type;

export const ComputerUseHostFailureReason = Schema.Literals([
  "permission-missing",
  "target-not-found",
  "target-identity-changed",
  "stale-observation",
  "unsupported-operation",
  "policy-denied",
  "approval-required",
  "confirmation-required",
  "target-closed",
  "lock-state-changed",
  "human-input-detected",
  "takeover",
  "interrupted",
  "timeout",
  "malformed-response",
  "host-disconnected",
]);
export type ComputerUseHostFailureReason = typeof ComputerUseHostFailureReason.Type;

const ComputerUseHostResponseFields = {
  hostId: ComputerUseHostId,
  connectionId: ComputerUseConnectionId,
  leaseId: ComputerUseLeaseId,
  requestId: ComputerUseRequestId,
};

export const ComputerUseHostResponse = Schema.Union([
  Schema.Struct({
    ...ComputerUseHostResponseFields,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
    error: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    ...ComputerUseHostResponseFields,
    ok: Schema.Literal(false),
    result: Schema.optional(Schema.Never),
    error: Schema.Struct({
      _tag: ComputerUseHostFailureTag,
      message: Schema.String.check(Schema.isMaxLength(4_096)),
      detail: Schema.optional(Schema.Unknown),
    }),
  }),
]);
export type ComputerUseHostResponse = typeof ComputerUseHostResponse.Type;

const ComputerUseScopeErrorFields = {
  operation: ComputerUseOperation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  turnId: TurnId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

export class ComputerUseNoAvailableHostError extends Schema.TaggedErrorClass<ComputerUseNoAvailableHostError>()(
  "ComputerUseNoAvailableHostError",
  ComputerUseScopeErrorFields,
) {
  override get message(): string {
    return `No verified Computer Use host is available for ${this.operation} in environment ${this.environmentId}.`;
  }
}

export class ComputerUseLeaseBusyError extends Schema.TaggedErrorClass<ComputerUseLeaseBusyError>()(
  "ComputerUseLeaseBusyError",
  {
    ...ComputerUseScopeErrorFields,
    activeThreadId: ThreadId,
    activeTurnId: TurnId,
  },
) {
  override get message(): string {
    return `Computer Use already has an active control lease in environment ${this.environmentId}.`;
  }
}

export class ComputerUseStoppedError extends Schema.TaggedErrorClass<ComputerUseStoppedError>()(
  "ComputerUseStoppedError",
  {
    ...ComputerUseScopeErrorFields,
    leaseId: ComputerUseLeaseId,
    reason: ComputerUseStopReason,
  },
) {
  override get message(): string {
    return `Computer Use ${this.operation} stopped because the control lease ended (${this.reason}).`;
  }
}

export class ComputerUseHostFailureError extends Schema.TaggedErrorClass<ComputerUseHostFailureError>()(
  "ComputerUseHostFailureError",
  {
    ...ComputerUseScopeErrorFields,
    leaseId: ComputerUseLeaseId,
    reason: ComputerUseHostFailureReason,
    remoteTag: ComputerUseHostFailureTag,
    remoteMessageLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    remoteDetailKind: Schema.optional(
      Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
    ),
  },
) {
  override get message(): string {
    return `Computer Use ${this.operation} failed on the host (${this.reason}).`;
  }
}

export class ComputerUseMalformedResponseError extends Schema.TaggedErrorClass<ComputerUseMalformedResponseError>()(
  "ComputerUseMalformedResponseError",
  {
    ...ComputerUseScopeErrorFields,
    leaseId: ComputerUseLeaseId,
  },
) {
  override get message(): string {
    return `Computer Use host returned a malformed response for ${this.operation}.`;
  }
}

export class ComputerUseInvalidRequestError extends Schema.TaggedErrorClass<ComputerUseInvalidRequestError>()(
  "ComputerUseInvalidRequestError",
  ComputerUseScopeErrorFields,
) {
  override get message(): string {
    return `Computer Use received an invalid ${this.operation} request.`;
  }
}

export class ComputerUseTimeoutError extends Schema.TaggedErrorClass<ComputerUseTimeoutError>()(
  "ComputerUseTimeoutError",
  {
    ...ComputerUseScopeErrorFields,
    leaseId: ComputerUseLeaseId,
    timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  },
) {
  override get message(): string {
    return `Computer Use ${this.operation} timed out after ${this.timeoutMs}ms.`;
  }
}

export const ComputerUseBrokerError = Schema.Union([
  ComputerUseNoAvailableHostError,
  ComputerUseLeaseBusyError,
  ComputerUseStoppedError,
  ComputerUseHostFailureError,
  ComputerUseInvalidRequestError,
  ComputerUseMalformedResponseError,
  ComputerUseTimeoutError,
]);
export type ComputerUseBrokerError = typeof ComputerUseBrokerError.Type;
