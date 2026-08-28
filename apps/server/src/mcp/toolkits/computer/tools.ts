import {
  ComputerUseActResult,
  ComputerUseActionBatch,
  ComputerUseActionDescriptor,
  ComputerUseActionRisk,
  ComputerUseApprovalId,
  ComputerUseBrokerError,
  ComputerUseCapabilityUnavailableError,
  ComputerUseObservation,
  ComputerUseObservationId,
  ComputerUsePolicyDecision,
  ComputerUseStatus,
  ComputerUseTarget,
  ComputerUseTargetId,
  ComputerUseTargetKind,
  ComputerUseTargetList,
  ComputerUseTurnUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/unstable/ai";

import * as ComputerUseToolkit from "../../../computerUse/ComputerUseToolkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ComputerUseToolkit.ComputerUseToolkit,
  McpSchema.McpServerClient,
];

const ComputerUseFailure = Schema.Union([
  ComputerUseCapabilityUnavailableError,
  ComputerUseTurnUnavailableError,
  ComputerUseBrokerError,
]);

export const ComputerUsePolicyBoundaryResult = Schema.TaggedStruct("policy", {
  approvalId: Schema.optional(ComputerUseApprovalId),
  decision: ComputerUsePolicyDecision,
  target: ComputerUseTarget,
  risk: ComputerUseActionRisk,
  action: Schema.optional(ComputerUseActionDescriptor),
});

const ComputerUseListTargetsInput = Schema.Struct({
  kind: Schema.optional(ComputerUseTargetKind),
});

const ComputerUseObserveInput = Schema.Struct({
  targetId: ComputerUseTargetId,
  includeScreenshot: Schema.optional(Schema.Boolean),
  includeAccessibility: Schema.optional(Schema.Boolean),
});

const ComputerUseActInput = Schema.Struct({
  targetId: ComputerUseTargetId,
  observationId: ComputerUseObservationId,
  actions: ComputerUseActionBatch.fields.actions,
  risk: Schema.optional(ComputerUseActionRisk),
});

const EmptyInput = Schema.Struct({});
const EmptyResult = Schema.Struct({});

const nativeComputerTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true) as T;

export const ComputerStatusTool = nativeComputerTool(
  Tool.make("computer_status", {
    description:
      "Report whether the T3-owned native Computer Use host is available, whether the computer is locked, and the current OS accessibility, capture, and input permissions.",
    parameters: EmptyInput,
    success: ComputerUseStatus,
    failure: ComputerUseFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Get computer status")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const ComputerListTargetsTool = nativeComputerTool(
  Tool.make("computer_list_targets", {
    description:
      "List native application, window, and structured Office document targets the verified T3 host can identify. Each target reports its strongest available integration and supported operations. Prefer office-document targets for Excel and PowerPoint. T3 Code and terminal applications are excluded and cannot be targeted.",
    parameters: ComputerUseListTargetsInput,
    success: ComputerUseTargetList,
    failure: ComputerUseFailure,
    dependencies,
  })
    .annotate(Tool.Title, "List computer targets")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);

export const ComputerObserveTool = nativeComputerTool(
  Tool.make("computer_observe", {
    description:
      "Observe one target before acting. Use an exact targetId returned by computer_list_targets. Returns a fresh observation ID, accessibility elements, and optionally a screenshot; an app grant may be requested first.",
    parameters: ComputerUseObserveInput,
    success: Schema.Union([ComputerUseObservation, ComputerUsePolicyBoundaryResult]),
    failure: ComputerUseFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Observe computer target")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);

export const ComputerActTool = nativeComputerTool(
  Tool.make("computer_act", {
    description:
      "Perform a bounded action batch against one exact target and observation. Set risk to the intended semantic consequence when it is sensitive, destructive, privileged, or forbidden. The server enforces its own risk floor, so tool input can raise but never lower protection. Returns a fresh observation.",
    parameters: ComputerUseActInput,
    success: Schema.Union([ComputerUseActResult, ComputerUsePolicyBoundaryResult]),
    failure: ComputerUseFailure,
    dependencies,
  }).annotate(Tool.Title, "Operate computer target"),
);

export const ComputerStopTool = nativeComputerTool(
  Tool.make("computer_stop", {
    description:
      "Immediately release this turn's Computer Use control lease and cancel its pending native operation.",
    parameters: EmptyInput,
    success: EmptyResult,
    failure: ComputerUseFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Stop computer use")
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const ComputerToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerListTargetsTool,
  ComputerObserveTool,
  ComputerActTool,
  ComputerStopTool,
);
