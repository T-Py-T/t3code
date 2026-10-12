import { describe, expect, it } from "vite-plus/test";

import { resolveCatalogDependencies } from "./resolve-catalog.ts";

describe("resolveCatalogDependencies", () => {
  const catalog = {
    effect: "3.19.0",
    yaml: "2.9.0",
  };

  it("replaces catalog: specs with concrete versions", () => {
    expect(
      resolveCatalogDependencies(
        { effect: "catalog:", yaml: "catalog:yaml" },
        catalog,
        "@example/pkg",
      ),
    ).toEqual({
      effect: "3.19.0",
      yaml: "2.9.0",
    });
  });

  it("leaves non-catalog dependency specs unchanged", () => {
    expect(
      resolveCatalogDependencies({ lodash: "^4.17.21" }, catalog, "@example/pkg"),
    ).toEqual({ lodash: "^4.17.21" });
  });

  it("throws when a catalog entry is missing", () => {
    expect(() =>
      resolveCatalogDependencies({ missing: "catalog:" }, catalog, "apps/desktop"),
    ).toThrowError(
      "Unable to resolve 'catalog:' for apps/desktop dependency 'missing'. Expected key 'missing' in root workspace catalog.",
    );
  });
});
