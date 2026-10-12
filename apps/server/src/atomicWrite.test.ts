import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "./atomicWrite.ts";

describe("writeFileStringAtomically", () => {
  it.effect("writes through a temp file and renames into place", () =>
    Effect.gen(function* () {
      const writes: Array<{ path: string; contents: string }> = [];
      const renames: Array<{ from: string; to: string }> = [];
      let tempCounter = 0;

      const fileSystemLayer = FileSystem.layerNoop({
        makeDirectory: () => Effect.void,
        makeTempDirectoryScoped: () =>
          Effect.sync(() => {
            tempCounter += 1;
            return `/tmp/atomic-write-${tempCounter}`;
          }),
        writeFileString: (path, contents) =>
          Effect.sync(() => {
            writes.push({ path, contents });
          }),
        rename: (from, to) =>
          Effect.sync(() => {
            renames.push({ from, to });
          }),
      });

      yield* writeFileStringAtomically({
        filePath: "/data/settings.json",
        contents: '{"ok":true}',
      }).pipe(Effect.provide(Layer.mergeAll(fileSystemLayer, Path.layer)));

      expect(writes).toEqual([
        { path: "/tmp/atomic-write-1/contents.tmp", contents: '{"ok":true}' },
      ]);
      expect(renames).toEqual([
        { from: "/tmp/atomic-write-1/contents.tmp", to: "/data/settings.json" },
      ]);
    }),
  );
});
