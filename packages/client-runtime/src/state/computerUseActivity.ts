import {
  ComputerUseActionRisk,
  ComputerUseHistoryOperation,
  ComputerUseHistoryState,
  type ComputerUseActionRisk as ComputerUseActionRiskValue,
  type ComputerUseHistoryOperation as ComputerUseHistoryOperationValue,
  type ComputerUseHistoryState as ComputerUseHistoryStateValue,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isHistoryState = Schema.is(ComputerUseHistoryState);
const isHistoryOperation = Schema.is(ComputerUseHistoryOperation);
const isActionRisk = Schema.is(ComputerUseActionRisk);

export interface ComputerUseActivityState {
  readonly state: ComputerUseHistoryStateValue;
  readonly operation?: ComputerUseHistoryOperationValue;
  readonly target?: {
    readonly displayName: string;
    readonly stableIdentity: string;
  };
  readonly risk?: ComputerUseActionRiskValue;
  readonly providerInstanceId?: string;
  readonly resultTag?: string;
}

export function decodeComputerUseActivity(
  activity: OrchestrationThreadActivity,
): ComputerUseActivityState | undefined {
  if (!activity.kind.startsWith("computer-use.")) return undefined;
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : undefined;
  if (!payload || !isHistoryState(payload.state)) return undefined;
  const target =
    payload.target && typeof payload.target === "object"
      ? (payload.target as Record<string, unknown>)
      : undefined;
  return {
    state: payload.state,
    ...(isHistoryOperation(payload.operation) ? { operation: payload.operation } : {}),
    ...(target &&
    typeof target.displayName === "string" &&
    typeof target.stableIdentity === "string"
      ? {
          target: {
            displayName: target.displayName,
            stableIdentity: target.stableIdentity,
          },
        }
      : {}),
    ...(isActionRisk(payload.risk) ? { risk: payload.risk } : {}),
    ...(typeof payload.providerInstanceId === "string"
      ? { providerInstanceId: payload.providerInstanceId }
      : {}),
    ...(typeof payload.resultTag === "string" ? { resultTag: payload.resultTag } : {}),
  };
}
