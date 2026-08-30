import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react", () => ({
  useId: () => ":provider-icon-test:",
}));

vi.mock("react-native-svg", () => ({
  Defs: "defs",
  LinearGradient: "linearGradient",
  Path: "path",
  Rect: "rect",
  Stop: "stop",
  Svg: "svg",
}));

vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));

import { ProviderIcon } from "./ProviderIcon";

type IconElement = {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>> & {
    readonly children?: IconElement | ReadonlyArray<IconElement | null> | null;
  };
};

function descendants(element: IconElement): ReadonlyArray<IconElement> {
  const children = Array.isArray(element.props.children)
    ? element.props.children
    : [element.props.children];

  return children.flatMap((child) =>
    child && typeof child === "object" ? [child, ...descendants(child)] : [],
  );
}

describe("ProviderIcon", () => {
  it("renders OMP with the official gradient while preserving distinct Pi and Atomic icons", () => {
    const omp = ProviderIcon({ provider: "omp", size: 24 }) as IconElement;
    const pi = ProviderIcon({ provider: "pi", size: 24 }) as IconElement;
    const atomic = ProviderIcon({ provider: "atomic", size: 24 }) as IconElement;
    const ompNodes = descendants(omp);
    const piNodes = descendants(pi);
    const atomicNodes = descendants(atomic);

    expect(omp.type).toBe("svg");
    expect(omp.props).toMatchObject({ width: 24, height: 24, viewBox: "0 0 800 800" });
    expect(
      ompNodes.filter((node) => node.type === "stop").map((node) => node.props.stopColor),
    ).toEqual(["#F84FCC", "#9362F4", "#00DBE4"]);
    expect(ompNodes.filter((node) => node.type === "path").map((node) => node.props.fill)).toEqual([
      "url(#provider-icon-test-omp-gradient)",
      "url(#provider-icon-test-omp-gradient)",
    ]);

    expect(piNodes.filter((node) => node.type === "path").map((node) => node.props.fill)).toEqual([
      "#fff",
      "#fff",
    ]);
    expect(atomic.props.viewBox).toBe("0 0 32 32");
    expect(
      atomicNodes.filter((node) => node.type === "path").map((node) => node.props.fill),
    ).toEqual(["#45475A", "#89B4FA"]);
  });
});
