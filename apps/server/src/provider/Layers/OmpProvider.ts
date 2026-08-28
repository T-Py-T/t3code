import type { OmpSettings } from "@t3tools/contracts";

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

function ompVersionStatus(version: string | null) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return {
      status: "warning" as const,
      message:
        "Oh My Pi RPC responded, but its version could not be verified. Oh My Pi 18.0.8 or newer is recommended.",
    };
  }
  const [major, minor, patch] = parsed;
  if (major < 18 || (major === 18 && minor === 0 && patch < 8)) {
    return {
      status: "error" as const,
      message:
        "This Oh My Pi release predates the RPC v2 workflow lifecycle supported by T3 Code. Upgrade to 18.0.8 or newer.",
    };
  }
  return { status: "ready" as const, message: "Oh My Pi RPC v2 is ready." };
}

function definition(settings: OmpSettings): PiCompatibleProviderDefinition {
  return {
    displayName: "Oh My Pi",
    agentDirEnvironmentVariable: "PI_CODING_AGENT_DIR",
    protocolVersion: 2,
    commandRequestType: "get_available_commands",
    synthesizeSkillPaths: true,
    additionalSlashCommands: [
      {
        name: "follow-up",
        description: "Queue a message to run after the active OMP turn finishes.",
        input: { hint: "message" },
      },
      {
        name: "steer",
        description: "Steer the active OMP turn immediately.",
        input: { hint: "message" },
      },
    ],
    discoveryArgs: [
      "--no-session",
      ...(settings.trustProjectResources ? [] : ["--no-extensions"]),
      "--approval-mode",
      settings.approvalMode,
    ],
    versionStatus: ompVersionStatus,
  };
}

export function buildInitialOmpProviderSnapshot(settings: OmpSettings) {
  return buildInitialPiCompatibleProviderSnapshot(settings, definition(settings));
}

export function checkOmpProviderStatus(
  settings: OmpSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return checkPiCompatibleProviderStatus(settings, definition(settings), cwd, environment);
}
