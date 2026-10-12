import { describe, expect, it } from "vite-plus/test";

import { describePreviewError } from "./errorCodeMessages";

describe("describePreviewError", () => {
  it("maps known Chromium error codes to friendly copy", () => {
    expect(describePreviewError("ERR_CONNECTION_REFUSED")).toBe("Connection refused");
    expect(describePreviewError("ERR_NAME_NOT_RESOLVED")).toBe("DNS address could not be found");
  });

  it("returns the raw description when it is not in the table", () => {
    expect(describePreviewError("ERR_CUSTOM")).toBe("ERR_CUSTOM");
  });

  it("falls back when the description is empty", () => {
    expect(describePreviewError("")).toBe("Network error");
  });
});
