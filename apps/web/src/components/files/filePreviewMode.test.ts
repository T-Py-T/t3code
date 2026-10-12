import { describe, expect, it } from "vite-plus/test";

import { isMarkdownPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";

describe("isMarkdownPreviewFile", () => {
  it("matches markdown and MDX paths case-insensitively", () => {
    expect(isMarkdownPreviewFile("docs/README.MD")).toBe(true);
    expect(isMarkdownPreviewFile("page.mdx")).toBe(true);
    expect(isMarkdownPreviewFile("notes.txt")).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] todo item\n- [x] done";

  it("toggles a task marker at the given offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] todo item\n- [x] done");
    expect(setMarkdownTaskChecked(markdown, 2, false)).toBe("- [ ] todo item\n- [x] done");
  });

  it("returns the original markdown when the offset is not a checkbox", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, -1, true)).toBe(markdown);
  });
});
