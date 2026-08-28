import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import { getDriverOption } from "./providerDriverMeta.ts";

describe("Oh My Pi provider presentation", () => {
  it("makes OMP selectable with its annotated settings form", () => {
    const option = getDriverOption(ProviderDriverKind.make("omp"));

    expect(option?.label).toBe("Oh My Pi");
    expect(option?.badgeLabel).toBe("Early Access");
    expect(option?.settingsSchema.fields).toHaveProperty("approvalMode");
  });
});
