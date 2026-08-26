import { type PiSettings, ProviderDriverKind } from "@t3tools/contracts";

import {
  makePiCompatibleAdapter,
  type PiCompatibleAdapterOptions,
  type PiCompatibleAdapterDefinition,
} from "./AtomicAdapter.ts";

const PI_ADAPTER_DEFINITION: PiCompatibleAdapterDefinition = {
  provider: ProviderDriverKind.make("pi"),
  displayName: "Pi",
  agentDirEnvironmentVariable: "PI_CODING_AGENT_DIR",
  rawSource: "pi.rpc",
};

/**
 * Pi and Atomic intentionally share one RPC lifecycle reducer. Atomic is a Pi
 * distribution with additional extensions; keeping one adapter seam makes
 * ordinary chat, thinking, tools, queueing, and settlement behave identically.
 */
export function makePiAdapter(settings: PiSettings, options?: PiCompatibleAdapterOptions) {
  return makePiCompatibleAdapter(settings, PI_ADAPTER_DEFINITION, options);
}
