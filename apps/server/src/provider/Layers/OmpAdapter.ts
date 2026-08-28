import { type OmpSettings, ProviderDriverKind } from "@t3tools/contracts";

import {
  makePiCompatibleAdapter,
  type PiCompatibleAdapterDefinition,
  type PiCompatibleAdapterOptions,
} from "./AtomicAdapter.ts";

const OMP_ADAPTER_DEFINITION: PiCompatibleAdapterDefinition = {
  provider: ProviderDriverKind.make("omp"),
  displayName: "Oh My Pi",
  agentDirEnvironmentVariable: "PI_CODING_AGENT_DIR",
  rawSource: "omp.rpc",
  protocolVersion: 2,
  cliFlavor: "omp",
};

/** Oh My Pi shares Pi's event vocabulary and adds RPC v2 lifecycle events. */
export function makeOmpAdapter(settings: OmpSettings, options?: PiCompatibleAdapterOptions) {
  return makePiCompatibleAdapter(settings, OMP_ADAPTER_DEFINITION, options);
}
