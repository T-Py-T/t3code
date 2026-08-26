import type { PiSettings } from "@t3tools/contracts";

import {
  buildInitialPiCompatibleProviderSnapshot,
  checkPiCompatibleProviderStatus,
  type PiCompatibleProviderDefinition,
} from "./AtomicProvider.ts";

function parseVersion(version: string | null): readonly [number, number, number] | undefined {
  if (!version) return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function piVersionStatus(version: string | null) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return {
      status: "warning" as const,
      message:
        "Pi RPC responded, but its version could not be verified. Pi 0.84.3 or newer is recommended.",
    };
  }
  const [major, minor, patch] = parsed;
  if (major === 0 && minor < 84) {
    return {
      status: "error" as const,
      message:
        "This Pi release predates the supported RPC lifecycle. Upgrade to Pi 0.84.3 or newer.",
    };
  }
  if (major === 0 && minor === 84 && patch < 3) {
    return {
      // T3 treats provider warning status as unavailable in the model picker.
      // Pi 0.84.0-0.84.2 is usable through the compatibility reducer, so keep
      // the provider selectable and carry the upgrade guidance in the message.
      status: "ready" as const,
      message:
        "Pi RPC is available through the 0.84 compatibility shim. Upgrade to Pi 0.84.3 or newer for complete tool and usage metadata.",
    };
  }
  return { status: "ready" as const, message: "Pi RPC is ready." };
}

const PI_PROVIDER_DEFINITION: PiCompatibleProviderDefinition = {
  displayName: "Pi",
  agentDirEnvironmentVariable: "PI_CODING_AGENT_DIR",
  versionStatus: piVersionStatus,
};

export function buildInitialPiProviderSnapshot(settings: PiSettings) {
  return buildInitialPiCompatibleProviderSnapshot(settings, PI_PROVIDER_DEFINITION);
}

export function checkPiProviderStatus(
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return checkPiCompatibleProviderStatus(settings, PI_PROVIDER_DEFINITION, cwd, environment);
}
