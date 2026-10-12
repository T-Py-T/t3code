import { assert, describe, it } from "@effect/vitest";
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as ServerSettingsModule from "../serverSettings.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettings,
  makeProviderSnapshotSettingsSource,
} from "./providerUpdateSettings.ts";

const baseSettings = (enableProviderUpdateChecks: boolean): ServerSettings =>
  ({ enableProviderUpdateChecks }) as ServerSettings;

describe("providerUpdateSettings", () => {
  it("makeProviderSnapshotSettings pairs provider config with the global flag", () => {
    const provider = { binaryPath: "/usr/bin/codex" };
    const snapshot = makeProviderSnapshotSettings(provider, baseSettings(false));
    assert.deepStrictEqual(snapshot, {
      provider,
      enableProviderUpdateChecks: false,
    });
  });

  it("haveProviderSnapshotSettingsChanged detects flag or provider changes", () => {
    const a = makeProviderSnapshotSettings({ v: 1 }, baseSettings(true));
    const same = makeProviderSnapshotSettings({ v: 1 }, baseSettings(true));
    const flagChanged = makeProviderSnapshotSettings({ v: 1 }, baseSettings(false));
    const providerChanged = makeProviderSnapshotSettings({ v: 2 }, baseSettings(true));

    assert.isFalse(haveProviderSnapshotSettingsChanged(a, same));
    assert.isTrue(haveProviderSnapshotSettingsChanged(a, flagChanged));
    assert.isTrue(haveProviderSnapshotSettingsChanged(a, providerChanged));
  });

  it.effect("makeProviderSnapshotSettingsSource maps streamed server settings", () =>
    Effect.gen(function* () {
      const provider = { name: "claude" };
      const serverSettings = {
        getSettings: Effect.succeed(baseSettings(true)),
        streamChanges: Stream.fromIterable([baseSettings(true), baseSettings(false)]),
      } as unknown as ServerSettingsModule.ServerSettingsService["Service"];
      const source = makeProviderSnapshotSettingsSource(provider, serverSettings);

      const initial = yield* source.getSettings;
      assert.deepStrictEqual(initial, { provider, enableProviderUpdateChecks: true });

      const streamed = yield* Stream.runCollect(source.streamSettings);
      assert.deepStrictEqual(Array.from(streamed), [
        { provider, enableProviderUpdateChecks: true },
        { provider, enableProviderUpdateChecks: false },
      ]);
    }),
  );
});
