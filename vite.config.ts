// @effect-diagnostics nodeBuiltinImport:off
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repositoryRoot = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const stagedCheckExtensions = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".scss",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const stagedIgnoredSegments = new Set([
  ".alchemy",
  ".reference",
  ".repos",
  "dist",
  "dist-electron",
  "node_modules",
]);
const mobileNativeConfigPaths = new Set([
  ".github/workflows/ci.yml",
  "apps/mobile/.editorconfig",
  "apps/mobile/.swiftlint.yml",
  "apps/mobile/Brewfile",
  "apps/mobile/detekt.yml",
  "package.json",
  "scripts/mobile-native-static-check.ts",
]);

function stagedPath(file: string): string {
  return (NodePath.isAbsolute(file) ? NodePath.relative(repositoryRoot, file) : file).replaceAll(
    NodePath.sep,
    "/",
  );
}

function isIgnoredStagedPath(file: string): boolean {
  const segments = file.split("/");
  return (
    segments.some((segment) => stagedIgnoredSegments.has(segment) || segment.endsWith(".icon")) ||
    file === "pnpm-lock.yaml" ||
    file.endsWith(".tsbuildinfo") ||
    file.endsWith("/routeTree.gen.ts") ||
    file === "routeTree.gen.ts" ||
    file.startsWith("apps/mobile/android/") ||
    file.startsWith("apps/mobile/ios/") ||
    file === "apps/web/public/mockServiceWorker.js" ||
    file === "apps/web/src/lib/vendor/qrcodegen.ts" ||
    file === "apps/mobile/uniwind-types.d.ts"
  );
}

function shellQuote(file: string): string {
  return `'${file.replaceAll("'", `'"'"'`)}'`;
}

function isResourceMonitorPath(file: string): boolean {
  return (
    file === "native/resource-monitor/Cargo.toml" ||
    file === "native/resource-monitor/Cargo.lock" ||
    (file.startsWith("native/resource-monitor/src/") && file.endsWith(".rs"))
  );
}

function isMobileNativePath(file: string): boolean {
  return (
    mobileNativeConfigPaths.has(file) ||
    (file.startsWith("apps/mobile/") && [".swift", ".kt", ".kts"].includes(NodePath.extname(file)))
  );
}

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: (files) => {
    const paths = files.map(stagedPath);
    const checkedPaths = paths.filter(
      (file) => stagedCheckExtensions.has(NodePath.extname(file)) && !isIgnoredStagedPath(file),
    );
    const commands: string[] = [];
    if (checkedPaths.length > 0) {
      commands.push(`vp check --fix ${checkedPaths.map(shellQuote).join(" ")}`);
    }
    if (paths.some(isResourceMonitorPath)) {
      commands.push("cargo fmt --manifest-path native/resource-monitor/Cargo.toml -- --check");
      commands.push("vp run test:resource-monitor");
    }
    if (paths.some(isMobileNativePath)) {
      commands.push("vp run lint:mobile");
    }
    return commands;
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/web/public/mockServiceWorker.js",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@t3tools/client-runtime",
              message:
                "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
            },
            {
              name: "@pierre/diffs/react",
              importNames: ["CodeView"],
              message:
                "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
            },
          ],
        },
      ],
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "warn",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-native-title-tooltip": "error",
      "t3code/namespace-node-imports": "error",
    },
    options: {
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
