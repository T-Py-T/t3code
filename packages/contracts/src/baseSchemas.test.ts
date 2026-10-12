import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ForwardCompatibleArray,
  PortSchema,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodePort = Schema.decodeUnknownSync(PortSchema);
const decodeTrimmed = Schema.decodeUnknownSync(TrimmedNonEmptyString);

describe("TrimmedNonEmptyString", () => {
  it("trims surrounding whitespace and rejects empty values", () => {
    expect(decodeTrimmed("  thread-1  ")).toBe("thread-1");
    expect(() => decodeTrimmed("   ")).toThrow();
  });
});

describe("PortSchema", () => {
  it("accepts valid TCP ports and rejects out-of-range values", () => {
    expect(decodePort(5733)).toBe(5733);
    expect(() => decodePort(0)).toThrow();
    expect(() => decodePort(70_000)).toThrow();
  });
});

describe("ThreadId", () => {
  it("brands non-empty trimmed identifiers", () => {
    const id = decodeThreadId(" abc ");
    expect(id).toBe("abc");
  });
});

describe("ForwardCompatibleArray", () => {
  const decodeStatuses = Schema.decodeUnknownSync(
    ForwardCompatibleArray(Schema.Literals(["ready", "pending"])),
  );

  it("drops unknown elements instead of failing the whole payload", () => {
    expect(decodeStatuses(["ready", "future-state", "pending"])).toEqual(["ready", "pending"]);
  });

  it("round-trips known values on encode", () => {
    const encoded = Schema.encodeUnknownSync(
      ForwardCompatibleArray(Schema.Literals(["ready", "pending"])),
    )(["pending"]);
    expect(encoded).toEqual(["pending"]);
  });
});
