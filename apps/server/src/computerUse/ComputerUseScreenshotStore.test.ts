import { EnvironmentId, type ComputerUseScreenshot } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";

import { makeWithLimits } from "./ComputerUseScreenshotStore.ts";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");

const screenshot = (base64: string): ComputerUseScreenshot => ({
  mimeType: "image/png",
  base64,
  width: 1,
  height: 1,
});

it.effect("evicts old screenshots by aggregate byte budget and isolates environments", () =>
  Effect.gen(function* () {
    const store = yield* makeWithLimits({
      retentionMs: 60_000,
      maxScreenshots: 128,
      maxTotalBase64Length: 8,
    }).pipe(Effect.provide(NodeServices.layer));
    const first = yield* store.retain(environmentId, screenshot("aaaaa"));
    const second = yield* store.retain(environmentId, screenshot("bbbbb"));

    expect(Option.isNone(yield* store.reveal(environmentId, first))).toBe(true);
    expect(Option.isSome(yield* store.reveal(environmentId, second))).toBe(true);
    expect(Option.isNone(yield* store.reveal(otherEnvironmentId, second))).toBe(true);

    yield* store.clear(environmentId);
    expect(Option.isNone(yield* store.reveal(environmentId, second))).toBe(true);
  }),
);
