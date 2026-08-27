import {
  ComputerUseApprovalId,
  ComputerUsePersistentGrantList,
  type ComputerUseAccessLevel,
  type ComputerUseActionRisk,
  type ComputerUseHostId,
  type ComputerUseGrantDuration,
  type ComputerUsePolicyDecision,
  type ComputerUsePersistentGrantSummary,
  type ComputerUseTarget,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

export interface ComputerUsePolicyScope {
  readonly environmentId: EnvironmentId;
  readonly hostId: ComputerUseHostId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface ComputerUsePolicyInput {
  readonly scope: ComputerUsePolicyScope;
  readonly target: ComputerUseTarget;
  readonly access: ComputerUseAccessLevel;
  readonly risk: ComputerUseActionRisk;
  readonly runtimeMode: RuntimeMode;
}

export interface ComputerUseGrantInput {
  readonly scope: ComputerUsePolicyScope;
  readonly target: ComputerUseTarget;
  readonly access: ComputerUseAccessLevel;
  readonly duration: ComputerUseGrantDuration;
}

export interface ComputerUseRevokeInput {
  readonly environmentId: EnvironmentId;
  readonly hostId: ComputerUseHostId;
  readonly stableIdentity: string;
}

export interface ComputerUseApprovalRequestInput {
  readonly input: ComputerUsePolicyInput;
  readonly decision: Exclude<ComputerUsePolicyDecision, { readonly _tag: "allow" }>;
}

export interface ComputerUseApprovalResolutionInput {
  readonly approvalId: ComputerUseApprovalId;
  readonly decision: ProviderApprovalDecision;
}

interface GrantRecord extends ComputerUseGrantInput {}

interface ConfirmationRecord {
  readonly scope: ComputerUsePolicyScope;
  readonly target: ComputerUseTarget;
  readonly risk: ComputerUseActionRisk;
}

interface PendingApproval extends ComputerUseApprovalRequestInput {}

interface ApprovalState {
  readonly pending: ReadonlyMap<ComputerUseApprovalId, PendingApproval>;
  readonly sequence: number;
}

interface ComputerUsePolicyPersistence {
  readonly load: Effect.Effect<ReadonlyArray<GrantRecord>>;
  readonly save: (grants: ReadonlyArray<GrantRecord>) => Effect.Effect<void>;
}

const FORBIDDEN_APPLICATION_IDS = new Set([
  "com.apple.terminal",
  "cmd.exe",
  "microsoft.windowsterminal_8wekyb3d8bbwe",
  "powershell.exe",
  "pwsh.exe",
  "wt.exe",
]);
const FORBIDDEN_APPLICATION_PREFIXES = ["com.t3tools.t3code"];

const isForbiddenApplicationId = (applicationId: string): boolean => {
  const normalized = applicationId.toLowerCase();
  return (
    FORBIDDEN_APPLICATION_IDS.has(normalized) ||
    FORBIDDEN_APPLICATION_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`),
    )
  );
};

export class ComputerUsePolicy extends Context.Service<
  ComputerUsePolicy,
  {
    readonly evaluate: (input: ComputerUsePolicyInput) => Effect.Effect<ComputerUsePolicyDecision>;
    readonly grant: (input: ComputerUseGrantInput) => Effect.Effect<void>;
    readonly revoke: (input: ComputerUseRevokeInput) => Effect.Effect<number>;
    readonly listPersistent: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<ComputerUsePersistentGrantSummary>>;
    readonly requestApproval: (
      input: ComputerUseApprovalRequestInput,
    ) => Effect.Effect<ComputerUseApprovalId>;
    readonly resolveApproval: (input: ComputerUseApprovalResolutionInput) => Effect.Effect<boolean>;
  }
>()("t3/computerUse/ComputerUsePolicy") {}

const makeWithPersistence = (persistence?: ComputerUsePolicyPersistence) =>
  Effect.gen(function* ComputerUsePolicyMake() {
    const grants = yield* SynchronizedRef.make<ReadonlyArray<GrantRecord>>(
      persistence ? yield* persistence.load : [],
    );
    const confirmations = yield* SynchronizedRef.make<ReadonlyArray<ConfirmationRecord>>([]);
    const approvals = yield* SynchronizedRef.make<ApprovalState>({
      pending: new Map(),
      sequence: 0,
    });

    const savePersistentGrants = persistence
      ? SynchronizedRef.get(grants).pipe(
          Effect.flatMap((current) =>
            persistence.save(current.filter((grant) => grant.duration === "persistent")),
          ),
        )
      : Effect.void;

    const grant: ComputerUsePolicy["Service"]["grant"] = Effect.fn("ComputerUsePolicy.grant")(
      function* (input) {
        yield* SynchronizedRef.update(grants, (current) => {
          const retained =
            input.duration === "persistent"
              ? current.filter(
                  (candidate) =>
                    candidate.duration !== "persistent" ||
                    candidate.scope.environmentId !== input.scope.environmentId ||
                    candidate.scope.hostId !== input.scope.hostId ||
                    candidate.target.stableIdentity !== input.target.stableIdentity ||
                    candidate.access !== input.access,
                )
              : current;
          return [...retained, input];
        });
        if (input.duration === "persistent") yield* savePersistentGrants;
      },
    );

    const revoke: ComputerUsePolicy["Service"]["revoke"] = Effect.fn("ComputerUsePolicy.revoke")(
      (input) =>
        SynchronizedRef.modify(grants, (current) => {
          const retained = current.filter(
            (candidate) =>
              candidate.scope.environmentId !== input.environmentId ||
              candidate.scope.hostId !== input.hostId ||
              candidate.target.stableIdentity !== input.stableIdentity,
          );
          return [current.length - retained.length, retained] as const;
        }).pipe(Effect.tap((removed) => (removed > 0 ? savePersistentGrants : Effect.void))),
    );

    const listPersistent: ComputerUsePolicy["Service"]["listPersistent"] = Effect.fn(
      "ComputerUsePolicy.listPersistent",
    )((environmentId) =>
      SynchronizedRef.get(grants).pipe(
        Effect.map((current) =>
          current.flatMap((grant) =>
            grant.duration === "persistent" && grant.scope.environmentId === environmentId
              ? [
                  {
                    environmentId: grant.scope.environmentId,
                    hostId: grant.scope.hostId,
                    target: grant.target,
                    access: grant.access,
                  } satisfies ComputerUsePersistentGrantSummary,
                ]
              : [],
          ),
        ),
      ),
    );

    const evaluate: ComputerUsePolicy["Service"]["evaluate"] = Effect.fn(
      "ComputerUsePolicy.evaluate",
    )(function* (input) {
      if (isForbiddenApplicationId(input.target.applicationId)) {
        return { _tag: "deny", reason: "forbidden-target" } as const;
      }
      if (input.risk === "forbidden") {
        return { _tag: "deny", reason: "forbidden-action" } as const;
      }

      const matchingGrant = yield* SynchronizedRef.modify(grants, (current) => {
        const index = current.findIndex((candidate) => {
          if (
            candidate.scope.environmentId !== input.scope.environmentId ||
            candidate.scope.hostId !== input.scope.hostId ||
            candidate.target.stableIdentity !== input.target.stableIdentity ||
            (candidate.access !== input.access && candidate.access !== "operate")
          ) {
            return false;
          }
          switch (candidate.duration) {
            case "persistent":
              return true;
            case "session":
              return candidate.scope.providerSessionId === input.scope.providerSessionId;
            case "turn":
            case "one-action":
              return (
                candidate.scope.threadId === input.scope.threadId &&
                candidate.scope.turnId === input.scope.turnId &&
                candidate.scope.providerSessionId === input.scope.providerSessionId
              );
          }
        });
        if (index < 0) return [undefined, current] as const;
        const found = current[index];
        if (
          found?.duration !== "one-action" ||
          (input.risk !== "inspect" && input.risk !== "reversible-local")
        ) {
          return [found, current] as const;
        }
        return [found, [...current.slice(0, index), ...current.slice(index + 1)]] as const;
      });

      if (!matchingGrant) {
        return { _tag: "request-app-grant", access: input.access } as const;
      }
      if (input.risk === "external-side-effect" || input.risk === "sensitive-data") {
        const confirmed = yield* SynchronizedRef.modify(confirmations, (current) => {
          const index = current.findIndex(
            (candidate) =>
              candidate.scope.environmentId === input.scope.environmentId &&
              candidate.scope.hostId === input.scope.hostId &&
              candidate.scope.threadId === input.scope.threadId &&
              candidate.scope.turnId === input.scope.turnId &&
              candidate.scope.providerSessionId === input.scope.providerSessionId &&
              candidate.target.stableIdentity === input.target.stableIdentity &&
              candidate.risk === input.risk,
          );
          return index < 0
            ? [false, current]
            : [true, [...current.slice(0, index), ...current.slice(index + 1)]];
        });
        if (confirmed) return { _tag: "allow" } as const;
        return { _tag: "request-action-confirmation", risk: input.risk } as const;
      }
      if (input.risk === "destructive-or-privileged") {
        return { _tag: "require-takeover", risk: input.risk } as const;
      }
      return { _tag: "allow" } as const;
    });

    const requestApproval: ComputerUsePolicy["Service"]["requestApproval"] = Effect.fn(
      "ComputerUsePolicy.requestApproval",
    )((input) =>
      SynchronizedRef.modify(approvals, (current) => {
        const approvalId = ComputerUseApprovalId.make(`computer-use-approval-${current.sequence}`);
        const pending = new Map(current.pending);
        pending.set(approvalId, input);
        return [approvalId, { pending, sequence: current.sequence + 1 }] as const;
      }),
    );

    const resolveApproval: ComputerUsePolicy["Service"]["resolveApproval"] = Effect.fn(
      "ComputerUsePolicy.resolveApproval",
    )(function* ({ approvalId, decision }) {
      const pending = yield* SynchronizedRef.modify(approvals, (current) => {
        const found = current.pending.get(approvalId);
        if (!found) return [undefined, current] as const;
        const next = new Map(current.pending);
        next.delete(approvalId);
        return [found, { ...current, pending: next }] as const;
      });
      if (!pending) return false;
      if (decision === "decline" || decision === "cancel") return true;
      const pendingDecision = pending.decision;
      if (pendingDecision._tag === "request-app-grant") {
        const duration: ComputerUseGrantDuration =
          decision === "acceptAlways"
            ? "persistent"
            : decision === "acceptForSession"
              ? "session"
              : "one-action";
        yield* grant({
          scope: pending.input.scope,
          target: pending.input.target,
          access: pendingDecision.access,
          duration,
        });
        return true;
      }
      if (pendingDecision._tag === "request-action-confirmation") {
        yield* SynchronizedRef.update(confirmations, (current) => [
          ...current,
          {
            scope: pending.input.scope,
            target: pending.input.target,
            risk: pendingDecision.risk,
          },
        ]);
      }
      return true;
    });

    return ComputerUsePolicy.of({
      evaluate,
      grant,
      revoke,
      listPersistent,
      requestApproval,
      resolveApproval,
    });
  });

export const make = makeWithPersistence();

const makeFilePersistence = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { computerUsePolicyPath } = yield* ServerConfig.ServerConfig;
  const decodePersistentGrants = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ComputerUsePersistentGrantList),
  );
  const encodePersistentGrants = Schema.encodeUnknownEffect(
    Schema.fromJsonString(ComputerUsePersistentGrantList),
  );
  const load = fs.exists(computerUsePolicyPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(computerUsePolicyPath).pipe(Effect.flatMap(decodePersistentGrants))
        : Effect.succeed([]),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not load Computer Use persistent grants; starting empty.", {
        cause,
      }).pipe(Effect.as([])),
    ),
  );
  const save = (grants: ReadonlyArray<GrantRecord>) =>
    encodePersistentGrants(grants).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: computerUsePolicyPath,
          contents: `${contents}\n`,
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logError("Could not persist Computer Use grants.", { cause }),
      ),
    );
  return { load, save } satisfies ComputerUsePolicyPersistence;
});

const makeLive = Effect.flatMap(makeFilePersistence, makeWithPersistence);

let activeComputerUsePolicy: ComputerUsePolicy["Service"] | undefined;

const makeActive = Effect.acquireRelease(
  makeLive.pipe(
    Effect.tap((policy) =>
      Effect.sync(() => {
        activeComputerUsePolicy = policy;
      }),
    ),
  ),
  (policy) =>
    Effect.sync(() => {
      if (activeComputerUsePolicy === policy) activeComputerUsePolicy = undefined;
    }),
);

export const resolveActiveComputerUseApproval = (
  approvalId: ComputerUseApprovalId,
  decision: ProviderApprovalDecision,
): Effect.Effect<boolean> =>
  activeComputerUsePolicy?.resolveApproval({ approvalId, decision }) ?? Effect.succeed(false);

export const layer = Layer.effect(ComputerUsePolicy, makeActive);
