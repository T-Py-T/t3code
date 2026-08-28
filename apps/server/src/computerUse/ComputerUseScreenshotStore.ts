import {
  ComputerUseScreenshotRevealToken,
  type ComputerUseScreenshot,
  type ComputerUseScreenshotRevealToken as ComputerUseScreenshotRevealTokenValue,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface StoredScreenshot {
  readonly environmentId: EnvironmentId;
  readonly screenshot: ComputerUseScreenshot;
  readonly expiresAt: number;
}

const SCREENSHOT_RETENTION_MS = 15 * 60 * 1_000;
const MAX_SCREENSHOTS = 128;

export class ComputerUseScreenshotStore extends Context.Service<
  ComputerUseScreenshotStore,
  {
    readonly retain: (
      environmentId: EnvironmentId,
      screenshot: ComputerUseScreenshot,
    ) => Effect.Effect<ComputerUseScreenshotRevealTokenValue>;
    readonly reveal: (
      environmentId: EnvironmentId,
      token: ComputerUseScreenshotRevealTokenValue,
    ) => Effect.Effect<Option.Option<ComputerUseScreenshot>>;
    readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("t3/computerUse/ComputerUseScreenshotStore") {}

export const make = Effect.gen(function* ComputerUseScreenshotStoreMake() {
  const crypto = yield* Crypto.Crypto;
  const screenshots = yield* SynchronizedRef.make(
    new Map<ComputerUseScreenshotRevealTokenValue, StoredScreenshot>(),
  );

  const retain: ComputerUseScreenshotStore["Service"]["retain"] = Effect.fn(
    "ComputerUseScreenshotStore.retain",
  )(function* (environmentId, screenshot) {
    const now = yield* Clock.currentTimeMillis;
    const token = ComputerUseScreenshotRevealToken.make(
      yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    );
    yield* SynchronizedRef.update(screenshots, (current) => {
      const retained = [...current].filter(([, entry]) => entry.expiresAt > now);
      const bounded = retained.slice(Math.max(0, retained.length - MAX_SCREENSHOTS + 1));
      return new Map([
        ...bounded,
        [token, { environmentId, screenshot, expiresAt: now + SCREENSHOT_RETENTION_MS }] as const,
      ]);
    });
    return token;
  });

  const reveal: ComputerUseScreenshotStore["Service"]["reveal"] = Effect.fn(
    "ComputerUseScreenshotStore.reveal",
  )(function* (environmentId, token) {
    const now = yield* Clock.currentTimeMillis;
    return yield* SynchronizedRef.modify(screenshots, (current) => {
      const entry = current.get(token);
      if (entry?.environmentId === environmentId && entry.expiresAt > now) {
        return [Option.some(entry.screenshot), current] as const;
      }
      if (!entry || entry.environmentId !== environmentId) {
        return [Option.none(), current] as const;
      }
      const next = new Map(current);
      next.delete(token);
      return [Option.none(), next] as const;
    });
  });

  return ComputerUseScreenshotStore.of({
    retain,
    reveal,
    clear: (environmentId) =>
      SynchronizedRef.update(screenshots, (current) => {
        const next = new Map(current);
        for (const [token, entry] of next) {
          if (entry.environmentId === environmentId) next.delete(token);
        }
        return next;
      }),
  });
});

export const layer = Layer.effect(ComputerUseScreenshotStore, make);
