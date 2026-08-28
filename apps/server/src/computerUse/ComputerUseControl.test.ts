import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ComputerUseInvocationScope } from "./ComputerUseBroker.ts";
import * as ComputerUseControl from "./ComputerUseControl.ts";

const scope = (turn: string): ComputerUseInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make(`thread-${turn}`),
  turnId: TurnId.make(`turn-${turn}`),
  providerSessionId: `session-${turn}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
});

it.effect("admits only one Computer Use owner per environment", () =>
  Effect.gen(function* () {
    const control = yield* ComputerUseControl.make;
    const first = scope("one");
    const second = scope("two");

    expect(yield* control.claim(first)).toBeUndefined();
    expect(yield* control.claim(second)).toEqual(first);
    expect(yield* control.activeFor(first.environmentId)).toMatchObject({
      threadId: first.threadId,
      turnId: first.turnId,
    });

    yield* control.releaseTurn(first.threadId, first.turnId);
    expect(yield* control.claim(second)).toBeUndefined();
  }),
);
