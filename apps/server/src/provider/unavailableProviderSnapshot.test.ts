import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildUnavailableProviderSnapshot } from "./unavailableProviderSnapshot.ts";

describe("buildUnavailableProviderSnapshot", () => {
  it.effect("marks the instance unavailable with probe error details", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildUnavailableProviderSnapshot({
        driverKind: "experimentalDriver",
        instanceId: ProviderInstanceId.make("missing"),
        displayName: "  My Fork Driver  ",
        accentColor: "#336699",
        reason: "Driver not shipped in this build",
        checkedAt: "2026-01-01T00:00:00.000Z",
      });

      assert.strictEqual(snapshot.instanceId, "missing");
      assert.strictEqual(snapshot.availability, "unavailable");
      assert.strictEqual(snapshot.unavailableReason, "Driver not shipped in this build");
      assert.strictEqual(snapshot.displayName, "My Fork Driver");
      assert.strictEqual(snapshot.accentColor, "#336699");
      assert.strictEqual(snapshot.enabled, false);
      assert.strictEqual(snapshot.status, "disabled");
      assert.strictEqual(snapshot.message, "Driver not shipped in this build");
      assert.strictEqual(snapshot.installed, false);
      assert.strictEqual(snapshot.driver, ProviderDriverKind.make("experimentalDriver"));
      assert.strictEqual(snapshot.checkedAt, "2026-01-01T00:00:00.000Z");
    }),
  );

  it.effect("falls back to the driver kind for display name when blank", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildUnavailableProviderSnapshot({
        driverKind: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
        reason: "Unavailable",
        checkedAt: "2026-01-02T00:00:00.000Z",
      });

      assert.strictEqual(snapshot.displayName, "codex");
      assert.isUndefined(snapshot.accentColor);
    }),
  );
});
