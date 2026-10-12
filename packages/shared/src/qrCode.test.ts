import { describe, expect, it } from "vite-plus/test";

import { QrCode } from "./qrCode.ts";

describe("QrCode", () => {
  it("encodes short text into a square module grid", () => {
    const code = QrCode.encodeText("t3://pair", QrCode.Ecc.LOW);
    expect(code.size).toBeGreaterThanOrEqual(21);
    expect(code.getModule(0, 0)).toBe(true);
    expect(code.getModule(code.size, code.size)).toBe(false);
  });

  it("encodes binary payloads and may boost error correction", () => {
    const code = QrCode.encodeBinary([0x54, 0x33], QrCode.Ecc.MEDIUM);
    expect(code.version).toBeGreaterThanOrEqual(1);
    expect(code.errorCorrectionLevel.ordinal).toBeGreaterThanOrEqual(QrCode.Ecc.MEDIUM.ordinal);
  });
});
