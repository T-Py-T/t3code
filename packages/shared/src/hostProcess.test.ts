import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { HostProcessPlatform, isHostWindows } from "./hostProcess.ts";

describe("hostProcess", () => {
  it("detects Windows from the injected platform service", () => {
    const onWindows = Effect.runSync(
      isHostWindows.pipe(Effect.provide(Layer.succeed(HostProcessPlatform, "win32"))),
    );
    const onLinux = Effect.runSync(
      isHostWindows.pipe(Effect.provide(Layer.succeed(HostProcessPlatform, "linux"))),
    );
    expect(onWindows).toBe(true);
    expect(onLinux).toBe(false);
  });
});
