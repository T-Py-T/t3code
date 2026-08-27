import {
  ComputerUseCapabilityUnavailableError,
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "computer";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly turnId?: TurnId;
  readonly runtimeMode?: RuntimeMode;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "computer",
): Effect.Effect<McpInvocationScope, ComputerUseCapabilityUnavailableError, McpInvocationContext>;
export function requireMcpCapability(capability: McpCapability) {
  return Effect.gen(function* () {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has(capability)) {
      if (capability === "computer") {
        return yield* new ComputerUseCapabilityUnavailableError({
          capability,
          environmentId: invocation.environmentId,
          threadId: invocation.threadId,
          providerSessionId: invocation.providerSessionId,
          providerInstanceId: invocation.providerInstanceId,
        });
      }
      return yield* new PreviewAutomationUnavailableError({
        capability,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
    }
    return invocation;
  }).pipe(Effect.withSpan("mcp.requireCapability", { attributes: { capability } }));
}
