import { TextGenerationError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  limitSection,
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
} from "./TextGenerationUtils.ts";

describe("limitSection", () => {
  it("returns short strings unchanged", () => {
    expect(limitSection("hello", 10)).toBe("hello");
  });

  it("appends a truncation marker when over the limit", () => {
    expect(limitSection("abcdefghij", 5)).toBe("abcde\n\n[truncated]");
  });
});

describe("sanitizeCommitSubject", () => {
  it("uses the first line, drops trailing periods, and caps length", () => {
    expect(sanitizeCommitSubject("  fix(web): trim titles.\nignored line  ")).toBe(
      "fix(web): trim titles",
    );
    expect(sanitizeCommitSubject("x".repeat(90)).length).toBeLessThanOrEqual(72);
  });

  it("falls back when the subject is empty", () => {
    expect(sanitizeCommitSubject("   \n")).toBe("Update project files");
  });
});

describe("sanitizePrTitle", () => {
  it("keeps the first non-empty line", () => {
    expect(sanitizePrTitle("  Ship feature\nbody")).toBe("Ship feature");
  });

  it("falls back when the title is blank", () => {
    expect(sanitizePrTitle("\n")).toBe("Update project changes");
  });
});

describe("normalizeCliError", () => {
  it("maps missing CLI binaries to a PATH error", () => {
    const error = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("spawn codex ENOENT"),
      "fallback",
    );
    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Codex CLI");
    expect(error.detail).toContain("PATH");
  });

  it("returns existing TextGenerationError values unchanged", () => {
    const existing = new TextGenerationError({
      operation: "generatePrContent",
      detail: "already typed",
    });
    expect(normalizeCliError("claude", "generatePrContent", existing, "fallback")).toBe(existing);
  });
});
