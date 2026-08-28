import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ComputerUseHostId,
  ComputerUseTargetId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ComputerUseTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ComputerUsePolicy from "./ComputerUsePolicy.ts";

const target: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-textedit"),
  kind: "application",
  displayName: "TextEdit",
  applicationId: "com.apple.TextEdit",
  stableIdentity: "macos:com.apple.TextEdit:APPLE",
};

it.effect("restores persistent grants only for the same verified host and target identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "computer-use-policy-" });
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const policyLayer = ComputerUsePolicy.layer.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const scope = {
        environmentId: EnvironmentId.make("environment-1"),
        hostId: ComputerUseHostId.make("signed-host-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("atomic"),
      } as const;

      const firstScope = yield* Scope.make();
      const firstServices = yield* Layer.build(policyLayer).pipe(Scope.provide(firstScope));
      const first = yield* ComputerUsePolicy.ComputerUsePolicy.pipe(Effect.provide(firstServices));
      yield* first.grant({ scope, target, access: "operate", duration: "persistent" });
      yield* Scope.close(firstScope, Exit.void);

      const secondScope = yield* Scope.make();
      const secondServices = yield* Layer.build(policyLayer).pipe(Scope.provide(secondScope));
      const restored = yield* ComputerUsePolicy.ComputerUsePolicy.pipe(
        Effect.provide(secondServices),
      );
      const nextTurn = {
        ...scope,
        threadId: ThreadId.make("thread-2"),
        turnId: TurnId.make("turn-2"),
        providerSessionId: "provider-session-2",
      };
      expect(
        yield* restored.evaluate({
          scope: nextTurn,
          target,
          access: "operate",
          risk: "reversible-local",
          runtimeMode: "full-access",
        }),
      ).toEqual({ _tag: "allow" });
      expect(
        yield* restored.evaluate({
          scope: { ...nextTurn, hostId: ComputerUseHostId.make("signed-host-2") },
          target,
          access: "operate",
          risk: "reversible-local",
          runtimeMode: "full-access",
        }),
      ).toEqual({ _tag: "request-app-grant", access: "operate" });
      yield* Scope.close(secondScope, Exit.void);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
