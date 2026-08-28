import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("BUILT_IN_DRIVERS", () => {
  it("ships every Pi-family integration as a first-class provider driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("pi");
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("omp");
  });
});
