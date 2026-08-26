// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * Containment rules (lifted from the reviewed #3650 inspection service):
 * - the resolved realpath must live under ~/.claude/projects (Claude) or the
 *   current thread workspace's .atomic/workflows directory;
 * - only .js files are served from Claude and .js/.ts from Atomic;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationGetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const SCRIPT_BYTE_CAP = 256 * 1024;

function claudeScriptsRoot(): string {
  return NodePath.join(NodeOS.homedir(), ".claude", "projects");
}

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
  readonly workspaceRoot?: string;
}) {
  const requested = input.scriptPath;
  const requestedExtension = NodePath.extname(requested);

  if (
    !NodePath.isAbsolute(requested) ||
    (requestedExtension !== ".js" && requestedExtension !== ".ts")
  ) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "invalid-path",
      scriptPath: requested,
    });
  }

  const configuredRoots = [
    { path: claudeScriptsRoot(), extensions: new Set([".js"]) },
    ...(input.workspaceRoot
      ? [
          {
            path: NodePath.resolve(input.workspaceRoot, ".atomic", "workflows"),
            workspaceRoot: NodePath.resolve(input.workspaceRoot),
            extensions: new Set([".js", ".ts"]),
          },
        ]
      : []),
  ];
  const roots = yield* Effect.tryPromise({
    try: async () => {
      const resolved = await Promise.all(
        configuredRoots.map(async (root) => {
          try {
            const resolvedRoot = await NodeFSP.realpath(root.path);
            if ("workspaceRoot" in root) {
              const resolvedWorkspace = await NodeFSP.realpath(root.workspaceRoot);
              if (
                resolvedRoot !== resolvedWorkspace &&
                !resolvedRoot.startsWith(`${resolvedWorkspace}${NodePath.sep}`)
              ) {
                return null;
              }
            }
            return { ...root, path: resolvedRoot };
          } catch {
            return null;
          }
        }),
      );
      return resolved.filter((root): root is NonNullable<typeof root> => root !== null);
    },
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "root-unavailable",
        scriptPath: requested,
        cause,
      }),
  });
  if (roots.length === 0) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "root-unavailable",
      scriptPath: requested,
    });
  }

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(requested),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "not-found",
        scriptPath: requested,
        cause,
      }),
  });

  const containingRoot = roots.find(
    (root) => resolved === root.path || resolved.startsWith(`${root.path}${NodePath.sep}`),
  );
  if (!containingRoot) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "outside-root",
      scriptPath: resolved,
    });
  }
  if (!containingRoot.extensions.has(NodePath.extname(resolved))) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: "not-js",
      scriptPath: resolved,
    });
  }

  // Pin every directory from the approved root to the script before opening
  // the file. A malicious process can otherwise replace `.atomic/workflows`
  // (or any nested directory) after the realpath containment check and make a
  // path-based open read outside the workspace. O_NOFOLLOW protects the final
  // component; comparing the still-open directory handles with lstat after
  // the file open detects directory replacement as well.
  const read = yield* Effect.tryPromise({
    try: async () => {
      const relativePath = NodePath.relative(containingRoot.path, resolved);
      const pathSegments = relativePath.split(NodePath.sep);
      const directoryPaths = [containingRoot.path];
      for (const segment of pathSegments.slice(0, -1)) {
        directoryPaths.push(NodePath.join(directoryPaths.at(-1)!, segment));
      }
      const directoryHandles: Array<{
        readonly path: string;
        readonly handle: Awaited<ReturnType<typeof NodeFSP.open>>;
        readonly dev: number;
        readonly ino: number;
      }> = [];
      let handle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
      try {
        for (const directoryPath of directoryPaths) {
          const directoryHandle = await NodeFSP.open(directoryPath, NodeFS.constants.O_RDONLY);
          const directoryStat = await directoryHandle.stat();
          if (!directoryStat.isDirectory()) {
            await directoryHandle.close();
            return { failure: "changed-during-read" as const };
          }
          directoryHandles.push({
            path: directoryPath,
            handle: directoryHandle,
            dev: directoryStat.dev,
            ino: directoryStat.ino,
          });
        }
        handle = await NodeFSP.open(
          resolved,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
        );
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { failure: "not-regular-file" as const };
        }
        for (const directory of directoryHandles) {
          const pathStat = await NodeFSP.lstat(directory.path);
          if (
            pathStat.isSymbolicLink() ||
            !pathStat.isDirectory() ||
            pathStat.ino !== directory.ino ||
            pathStat.dev !== directory.dev
          ) {
            return { failure: "changed-during-read" as const };
          }
        }
        // The opened inode must also still be the file reached through the
        // pinned directory chain. Restoring a swapped directory before this
        // check exposes the original file again and produces an inode mismatch.
        const pathStat = await NodeFSP.lstat(resolved);
        if (pathStat.isSymbolicLink() || stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
          return { failure: "changed-during-read" as const };
        }
        const truncated = stat.size > SCRIPT_BYTE_CAP;
        const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          contents: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated,
        };
      } finally {
        await handle?.close();
        await Promise.all(directoryHandles.map(({ handle: directory }) => directory.close()));
      }
    },
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "read-failed",
        scriptPath: resolved,
        cause,
      }),
  });
  if ("failure" in read) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: read.failure,
      scriptPath: resolved,
    });
  }

  return {
    scriptPath: resolved,
    contents: read.contents,
    truncated: read.truncated,
  };
});
