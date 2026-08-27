import * as NodeURL from "node:url";

import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import {
  macOsComputerUseHelperPathCandidates,
  runMacOsComputerUseTransport,
  shouldHashDevelopmentHelper,
} from "./MacOsComputerUseHost.ts";

describe("macOsComputerUseHelperPathCandidates", () => {
  it("prefers the explicit helper path without falling back", () => {
    expect(
      macOsComputerUseHelperPathCandidates(
        { computerUseHelperPath: "/Applications/T3 Code.app/Contents/Helpers/T3CodeComputerUse" },
        "file:///repo/apps/server/dist/bin.mjs",
      ),
    ).toEqual(["/Applications/T3 Code.app/Contents/Helpers/T3CodeComputerUse"]);
  });

  it("resolves the helper from a bundled server module", () => {
    const candidates = macOsComputerUseHelperPathCandidates(
      { computerUseHelperPath: undefined },
      "file:///repo/apps/server/dist/bin.mjs",
    );

    expect(candidates).toContain(
      NodeURL.fileURLToPath(
        new URL("file:///repo/native/computer-use-macos/.build/debug/T3CodeComputerUse"),
      ),
    );
  });

  it("resolves the helper when the module executes from source", () => {
    const candidates = macOsComputerUseHelperPathCandidates(
      { computerUseHelperPath: undefined },
      "file:///repo/apps/server/src/computerUse/MacOsComputerUseHost.ts",
    );

    expect(candidates).toContain(
      NodeURL.fileURLToPath(
        new URL("file:///repo/native/computer-use-macos/.build/debug/T3CodeComputerUse"),
      ),
    );
  });
});

describe("shouldHashDevelopmentHelper", () => {
  it("accepts an explicitly identified development helper", () => {
    expect(
      shouldHashDevelopmentHelper({
        computerUseHelperDevelopment: true,
        computerUseHelperPath: "/repo/native/computer-use-macos/.build/debug/T3CodeComputerUse",
        devUrl: undefined,
      }),
    ).toBe(true);
  });

  it("keeps an explicit release helper on stable-signature verification", () => {
    expect(
      shouldHashDevelopmentHelper({
        computerUseHelperDevelopment: undefined,
        computerUseHelperPath: "/Applications/T3 Code.app/Contents/Resources/T3CodeComputerUse",
        devUrl: undefined,
      }),
    ).toBe(false);
  });
});

describe("runMacOsComputerUseTransport", () => {
  effectIt.effect("starts every long-lived transport pump concurrently", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);
      const pump = Ref.update(started, (count) => count + 1).pipe(Effect.andThen(Effect.never));
      const fiber = yield* runMacOsComputerUseTransport(
        [pump, pump, pump, pump],
        Effect.never,
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* Ref.get(started)).toBe(4);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
