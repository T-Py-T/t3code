import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";

import {
  getBackgroundActivityPresetSettings,
  normalizeBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

describe("backgroundActivitySettings", () => {
  it("resolves preset profiles", () => {
    const resolved = resolveBackgroundActivitySettings({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });

    expect(resolved.profile).toBe("balanced");
    expect(Duration.toMillis(resolved.automaticGitFetchInterval)).toBeGreaterThan(0);
  });

  it("collapses custom settings that match a preset", () => {
    const preset = getBackgroundActivityPresetSettings("performance");

    const normalized = normalizeBackgroundActivitySettings({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: preset.automaticGitFetchInterval,
        providerHealthRefreshInterval: preset.providerHealthRefreshInterval,
        hostPowerMonitorActiveInterval: preset.hostPowerMonitorActiveInterval,
        hostPowerMonitorIdleInterval: preset.hostPowerMonitorIdleInterval,
        idleClientTtl: preset.idleClientTtl,
        pauseWhenHostLocked: preset.pauseWhenHostLocked,
        pauseWhenHostLowPower: preset.pauseWhenHostLowPower,
        pauseWhenClientLowPower: preset.pauseWhenClientLowPower,
        pauseWhenOnBattery: preset.pauseWhenOnBattery,
      },
    });

    expect(normalized).toEqual({
      schemaVersion: 1,
      profile: "performance",
      overrides: {},
    });
  });
});
