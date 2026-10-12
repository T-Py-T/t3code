import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  nextFileCommentId,
  remapFileCommentAnnotations,
  type FileCommentLineAnnotation,
} from "./fileCommentAnnotations";

describe("normalizeFileCommentRange", () => {
  it("orders start and end lines", () => {
    expect(normalizeFileCommentRange({ start: 8, end: 3 })).toEqual({
      startLine: 3,
      endLine: 8,
    });
  });
});

describe("formatFileCommentRange", () => {
  it("formats single-line and multi-line ranges", () => {
    expect(formatFileCommentRange(4, 4)).toBe("L4");
    expect(formatFileCommentRange(2, 5)).toBe("L2 to L5");
  });
});

describe("nextFileCommentId", () => {
  it("returns unique ids", () => {
    const first = nextFileCommentId();
    const second = nextFileCommentId();
    expect(first).not.toBe(second);
    expect(first.startsWith("file-comment-")).toBe(true);
  });
});

describe("remapFileCommentAnnotations", () => {
  it("re-anchors comment entries to the annotation line", () => {
    const annotations: FileCommentLineAnnotation[] = [
      {
        lineNumber: 12,
        metadata: {
          entries: [
            {
              id: "c-1",
              kind: "comment",
              startLine: 10,
              endLine: 11,
              text: "note",
            },
          ],
        },
      },
    ];

    expect(remapFileCommentAnnotations(annotations)).toEqual([
      {
        lineNumber: 12,
        metadata: {
          entries: [
            {
              id: "c-1",
              kind: "comment",
              startLine: 11,
              endLine: 12,
              text: "note",
            },
          ],
        },
      },
    ]);
  });
});
