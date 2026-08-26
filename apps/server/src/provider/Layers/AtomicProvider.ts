import {
  type AtomicSettings,
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeAtomicRpcProcess } from "../atomic/AtomicRpcProcess.ts";
import { expandHomePath } from "../../pathExpansion.ts";

const AtomicModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  provider: Schema.String,
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type AtomicModel = typeof AtomicModel.Type;

const AtomicModelsData = Schema.Struct({ models: Schema.Array(AtomicModel) });
const AtomicStateData = Schema.Struct({
  model: Schema.optional(Schema.NullOr(AtomicModel)),
  thinkingLevel: Schema.optional(Schema.String),
});
const AtomicCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
const AtomicCommandsData = Schema.Struct({ commands: Schema.Array(AtomicCommand) });

const decodeModels = Schema.decodeUnknownOption(AtomicModelsData);
const decodeState = Schema.decodeUnknownOption(AtomicStateData);
const decodeCommands = Schema.decodeUnknownOption(AtomicCommandsData);
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface PiCompatibleProviderSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly agentDir: string;
  readonly customModels: ReadonlyArray<string>;
}

export interface PiCompatibleProviderDefinition {
  readonly displayName: string;
  readonly agentDirEnvironmentVariable: "ATOMIC_CODING_AGENT_DIR" | "PI_CODING_AGENT_DIR";
  readonly versionStatus?: (
    version: string | null,
  ) => { readonly status: "ready" | "warning" | "error"; readonly message: string } | undefined;
}

function presentation(definition: PiCompatibleProviderDefinition) {
  return {
    displayName: definition.displayName,
    badgeLabel: "Early Access",
    showInteractionModeToggle: false,
    requiresNewThreadForModelChange: false,
  } as const;
}

function piCompatibleEnvironment(
  settings: PiCompatibleProviderSettings,
  definition: PiCompatibleProviderDefinition,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return settings.agentDir
    ? {
        ...environment,
        [definition.agentDirEnvironmentVariable]: expandHomePath(settings.agentDir),
      }
    : environment;
}

function supportedThinkingLevels(model: AtomicModel): ReadonlyArray<string> {
  if (model.reasoning !== true) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if ((level === "xhigh" || level === "max") && mapped === undefined) return false;
    return true;
  });
}

function capabilitiesForModel(
  model: AtomicModel,
  currentThinkingLevel?: string,
): ModelCapabilities {
  const levels = supportedThinkingLevels(model);
  if (levels.length <= 1) return EMPTY_CAPABILITIES;
  const selected = levels.includes(currentThinkingLevel ?? "") ? currentThinkingLevel : undefined;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Thinking",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1),
          ...(level === selected ? { isDefault: true } : {}),
        })),
        ...(selected ? { currentValue: selected } : {}),
      },
    ],
  });
}

function modelSlug(model: AtomicModel): string {
  return `${model.provider}/${model.id}`;
}

function modelsFromRpc(input: {
  readonly models: ReadonlyArray<AtomicModel>;
  readonly defaultModel?: AtomicModel | null;
  readonly thinkingLevel?: string;
}): ReadonlyArray<ServerProviderModel> {
  const defaultSlug = input.defaultModel ? modelSlug(input.defaultModel) : undefined;
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const model of input.models) {
    const slug = modelSlug(model);
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model.name?.trim() || model.id,
      subProvider: model.provider,
      isCustom: false,
      ...(slug === defaultSlug ? { isDefault: true } : {}),
      capabilities: capabilitiesForModel(model, input.thinkingLevel),
    });
  }
  return models;
}

function commandsFromRpc(commands: ReadonlyArray<typeof AtomicCommand.Type>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const slashCommands = commands
    .filter((command) => command.name.trim().length > 0)
    .map((command) => ({
      name: command.name.trim(),
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
    }));
  const skills = commands
    .filter(
      (command): command is typeof command & { readonly path: string } =>
        command.source === "skill" && typeof command.path === "string" && command.path.length > 0,
    )
    .map((command) => ({
      name: command.name.replace(/^skill:/, ""),
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
      path: command.path,
      ...(command.location ? { scope: command.location } : {}),
      enabled: true,
    }));
  return { slashCommands, skills };
}

export function buildInitialPiCompatibleProviderSnapshot(
  settings: PiCompatibleProviderSettings,
  definition: PiCompatibleProviderDefinition,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: presentation(definition),
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? `Checking ${definition.displayName} CLI availability...`
          : `${definition.displayName} is disabled in T3 Code settings.`,
      },
    }),
  );
}

export const checkPiCompatibleProviderStatus = Effect.fn("checkPiCompatibleProviderStatus")(
  function* (
    settings: PiCompatibleProviderSettings,
    definition: PiCompatibleProviderDefinition,
    cwd: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = providerModelsFromSettings(
      [],
      settings.customModels,
      EMPTY_CAPABILITIES,
    );
    if (!settings.enabled) {
      return yield* buildInitialPiCompatibleProviderSnapshot(settings, definition);
    }

    const env = piCompatibleEnvironment(settings, definition, environment);
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], { env });
    const versionResult = yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        shell: spawnCommand.shell,
      }),
    ).pipe(Effect.timeoutOption(Duration.seconds(4)), Effect.result);

    if (Result.isFailure(versionResult)) {
      return buildServerProvider({
        presentation: presentation(definition),
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(versionResult.failure),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(versionResult.failure)
            ? `${definition.displayName} CLI (${settings.binaryPath}) is not installed or not on PATH.`
            : `Failed to execute the ${definition.displayName} CLI health check.`,
        },
      });
    }
    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: presentation(definition),
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `${definition.displayName} CLI timed out while running --version.`,
        },
      });
    }
    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      return buildServerProvider({
        presentation: presentation(definition),
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `${definition.displayName} CLI is installed but failed to run.`,
        },
      });
    }

    const discovery = yield* Effect.gen(function* () {
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: settings.binaryPath,
        runtimeName: definition.displayName,
        args: ["--no-session", "--no-approve"],
        cwd,
        environment: env,
      });
      const [stateResponse, modelsResponse, commandsResponse] = yield* Effect.all(
        [
          // No explicit timeout: these are the first commands on a freshly
          // spawned process, so they inherit the RPC startup budget.
          rpc.request({ type: "get_state" }),
          rpc.request({ type: "get_available_models" }),
          rpc.request({ type: "get_commands" }),
        ],
        { concurrency: "unbounded" },
      );
      const state = Option.getOrUndefined(decodeState(stateResponse.data));
      const modelData = Option.getOrUndefined(decodeModels(modelsResponse.data));
      const commandData = Option.getOrUndefined(decodeCommands(commandsResponse.data));
      const models = modelsFromRpc({
        models: modelData?.models ?? [],
        defaultModel: state?.model ?? null,
        // exactOptionalPropertyTypes: an absent thinking level must be omitted
        // rather than passed as undefined.
        ...(state?.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
      });
      return { models, ...commandsFromRpc(commandData?.commands ?? []) };
    }).pipe(Effect.scoped, Effect.result);

    if (Result.isFailure(discovery)) {
      return buildServerProvider({
        presentation: presentation(definition),
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `${definition.displayName} RPC model discovery failed. Check ${definition.displayName} configuration and credentials.`,
        },
      });
    }
    const discovered = discovery.success;
    const models = providerModelsFromSettings(
      discovered.models,
      settings.customModels,
      EMPTY_CAPABILITIES,
    );
    const versionStatus = definition.versionStatus?.(version);
    return buildServerProvider({
      presentation: presentation(definition),
      enabled: true,
      checkedAt,
      models,
      slashCommands: discovered.slashCommands,
      skills: discovered.skills,
      probe: {
        installed: true,
        version,
        status: versionStatus?.status ?? (models.length > 0 ? "ready" : "warning"),
        auth: { status: models.length > 0 ? "authenticated" : "unknown" },
        message:
          versionStatus?.message ??
          (models.length > 0
            ? `${definition.displayName} RPC is ready.`
            : `${definition.displayName} is installed, but it reported no configured models.`),
      },
    });
  },
);

const ATOMIC_PROVIDER_DEFINITION: PiCompatibleProviderDefinition = {
  displayName: "Atomic",
  agentDirEnvironmentVariable: "ATOMIC_CODING_AGENT_DIR",
};

export function buildInitialAtomicProviderSnapshot(settings: AtomicSettings) {
  return buildInitialPiCompatibleProviderSnapshot(settings, ATOMIC_PROVIDER_DEFINITION);
}

export function checkAtomicProviderStatus(
  settings: AtomicSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return checkPiCompatibleProviderStatus(settings, ATOMIC_PROVIDER_DEFINITION, cwd, environment);
}
