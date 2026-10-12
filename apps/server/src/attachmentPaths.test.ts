import { describe, expect, it } from "@effect/vitest";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";

describe("normalizeAttachmentRelativePath", () => {
  it("normalizes separators and strips leading slashes", () => {
    expect(normalizeAttachmentRelativePath("\\images\\photo.png")).toBe("images/photo.png");
    expect(normalizeAttachmentRelativePath("/docs/readme.md")).toBe("docs/readme.md");
  });

  it("rejects parent traversal and null bytes", () => {
    expect(normalizeAttachmentRelativePath("../secret")).toBeNull();
    expect(normalizeAttachmentRelativePath("..\\secret")).toBeNull();
    expect(normalizeAttachmentRelativePath("file\0name")).toBeNull();
  });
});

describe("resolveAttachmentRelativePath", () => {
  it("resolves paths under the attachments root", () => {
    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: "/data/attachments",
      relativePath: "thread/a.png",
    });

    expect(resolved).toBe("/data/attachments/thread/a.png");
  });

  it("rejects paths that escape the attachments root", () => {
    expect(
      resolveAttachmentRelativePath({
        attachmentsDir: "/data/attachments",
        relativePath: "../outside.txt",
      }),
    ).toBeNull();
  });
});
