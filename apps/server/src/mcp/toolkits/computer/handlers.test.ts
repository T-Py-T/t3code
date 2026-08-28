import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { classifyComputerUseBatch, requireComputerUseScope } from "./handlers.ts";

it("classifies pointer and keyboard actions on the server instead of trusting the agent", () => {
  expect(
    classifyComputerUseBatch({
      actions: [
        { _tag: "move", x: 10, y: 20 },
        { _tag: "scroll", deltaX: 0, deltaY: 100 },
      ],
    }),
  ).toBe("reversible-local");

  expect(classifyComputerUseBatch({ actions: [{ _tag: "click", x: 10, y: 20 }] })).toBe(
    "external-side-effect",
  );
  expect(
    classifyComputerUseBatch({
      actions: [{ _tag: "keypress", key: "Enter", modifiers: [], phase: "press" }],
    }),
  ).toBe("external-side-effect");

  expect(classifyComputerUseBatch({ actions: [{ _tag: "click", x: 10, y: 20 }] }, "inspect")).toBe(
    "external-side-effect",
  );
  expect(
    classifyComputerUseBatch(
      { actions: [{ _tag: "text-entry", text: "account number" }] },
      "sensitive-data",
    ),
  ).toBe("sensitive-data");
  expect(
    classifyComputerUseBatch(
      { actions: [{ _tag: "click", x: 10, y: 20 }] },
      "destructive-or-privileged",
    ),
  ).toBe("destructive-or-privileged");
  expect(classifyComputerUseBatch({ actions: [{ _tag: "move", x: 10, y: 20 }] }, "forbidden")).toBe(
    "forbidden",
  );
});

it.effect("requires an active provider turn before exposing a Computer Use scope", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("pi"),
    capabilities: new Set(["computer"]),
    runtimeMode: "approval-required",
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const unavailable = yield* requireComputerUseScope.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(unavailable._tag).toBe("ComputerUseTurnUnavailableError");

    const turnId = TurnId.make("turn-1");
    const scope = yield* requireComputerUseScope.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        turnId,
      }),
    );
    expect(scope).toMatchObject({
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      turnId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  });
});
