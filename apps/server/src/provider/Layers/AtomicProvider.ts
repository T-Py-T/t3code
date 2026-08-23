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

const PRESENTATION = {
  displayName: "Atomic",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

function atomicEnvironment(
  settings: AtomicSettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return settings.agentDir
    ? { ...environment, ATOMIC_CODING_AGENT_DIR: settings.agentDir }
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

export function buildInitialAtomicProviderSnapshot(
  settings: AtomicSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Atomic CLI availability..."
          : "Atomic is disabled in T3 Code settings.",
      },
    }),
  );
}

export const checkAtomicProviderStatus = Effect.fn("checkAtomicProviderStatus")(function* (
  settings: AtomicSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
  if (!settings.enabled) {
    return yield* buildInitialAtomicProviderSnapshot(settings);
  }

  const env = atomicEnvironment(settings, environment);
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
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionResult.failure)
          ? "Atomic CLI (`atomic`) is not installed or not on PATH."
          : "Failed to execute the Atomic CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Atomic CLI timed out while running `atomic --version`.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Atomic CLI is installed but failed to run.",
      },
    });
  }

  const discovery = yield* Effect.gen(function* () {
    const rpc = yield* makeAtomicRpcProcess({
      binaryPath: settings.binaryPath,
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
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Atomic RPC model discovery failed. Check Atomic configuration and credentials.",
      },
    });
  }
  const discovered = discovery.success;
  const models = providerModelsFromSettings(
    discovered.models,
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: discovered.slashCommands,
    skills: discovered.skills,
    probe: {
      installed: true,
      version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: models.length > 0 ? "authenticated" : "unknown" },
      message:
        models.length > 0
          ? "Atomic RPC is ready."
          : "Atomic is installed, but it reported no configured models.",
    },
  });
});
