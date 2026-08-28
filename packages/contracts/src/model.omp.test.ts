import { describe, expect, it } from "vite-plus/test";

import { providerSupportsTextGeneration } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("Oh My Pi model capabilities", () => {
  it("keeps OMP selectable for sessions without advertising auxiliary text generation", () => {
    expect(providerSupportsTextGeneration(ProviderDriverKind.make("omp"))).toBe(false);
  });
});
