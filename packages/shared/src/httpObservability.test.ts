import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import { describe, expect, it } from "vite-plus/test";

import { httpHeaderRedactionLayer } from "./httpObservability.ts";

describe("httpHeaderRedactionLayer", () => {
  it("extends the redacted header list with dpop", () => {
    const names = Effect.runSync(
      Headers.CurrentRedactedNames.pipe(Effect.provide(httpHeaderRedactionLayer)),
    );
    expect(names).toContain("dpop");
  });
});
