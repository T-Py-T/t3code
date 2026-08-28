import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  parseWindowsAuthenticodeIdentity,
  windowsAuthenticodeProbeInput,
  windowsComputerUseHelperPathCandidates,
} from "./WindowsComputerUseHost.ts";

describe("windowsComputerUseHelperPathCandidates", () => {
  it("prefers the explicit helper path without falling back", () => {
    expect(
      windowsComputerUseHelperPathCandidates(
        { computerUseHelperPath: "C:\\Program Files\\T3 Code\\T3CodeComputerUse.exe" },
        "x64",
        "file:///repo/apps/server/dist/bin.mjs",
      ),
    ).toEqual(["C:\\Program Files\\T3 Code\\T3CodeComputerUse.exe"]);
  });

  it("resolves the helper from a bundled server module", () => {
    const candidates = windowsComputerUseHelperPathCandidates(
      { computerUseHelperPath: undefined },
      "x64",
      "file:///repo/apps/server/dist/bin.mjs",
    );

    const preferred = NodeURL.fileURLToPath(
      new URL("file:///repo/native/computer-use-windows/publish/win-x64/T3CodeComputerUse.exe"),
    );
    const fallback = NodeURL.fileURLToPath(
      new URL("file:///repo/native/computer-use-windows/publish/win-arm64/T3CodeComputerUse.exe"),
    );
    expect(candidates.indexOf(preferred)).toBeLessThan(candidates.indexOf(fallback));
  });

  it("resolves the helper when the module executes from source", () => {
    const candidates = windowsComputerUseHelperPathCandidates(
      { computerUseHelperPath: undefined },
      "arm64",
      "file:///repo/apps/server/src/computerUse/WindowsComputerUseHost.ts",
    );

    const preferred = NodeURL.fileURLToPath(
      new URL("file:///repo/native/computer-use-windows/publish/win-arm64/T3CodeComputerUse.exe"),
    );
    const fallback = NodeURL.fileURLToPath(
      new URL("file:///repo/native/computer-use-windows/publish/win-x64/T3CodeComputerUse.exe"),
    );
    expect(candidates.indexOf(preferred)).toBeLessThan(candidates.indexOf(fallback));
  });

  it("keeps the other supported architecture as a development fallback", () => {
    const candidates = windowsComputerUseHelperPathCandidates(
      { computerUseHelperPath: undefined },
      "x64",
      "file:///repo/apps/server/dist/bin.mjs",
    );

    const fallback = NodeURL.fileURLToPath(
      new URL("file:///repo/native/computer-use-windows/publish/win-arm64/T3CodeComputerUse.exe"),
    );
    expect(candidates).toContain(fallback);
    expect(candidates.indexOf(fallback)).toBeGreaterThan(1);
  });
});

describe("parseWindowsAuthenticodeIdentity", () => {
  it("accepts a valid signed helper identity", () => {
    expect(
      parseWindowsAuthenticodeIdentity(
        JSON.stringify({
          Status: "Valid",
          Subject: "CN=T3 Code Test Publisher, O=T3 Code",
          Thumbprint: "00aabbccddeeff",
        }),
      ),
    ).toEqual({
      subject: "authenticode:00AABBCCDDEEFF",
      publisher: "CN=T3 Code Test Publisher, O=T3 Code",
    });
  });

  it("rejects unsigned or incomplete identities", () => {
    expect(
      parseWindowsAuthenticodeIdentity(
        JSON.stringify({ Status: "NotSigned", Subject: null, Thumbprint: null }),
      ),
    ).toBeUndefined();
    expect(
      parseWindowsAuthenticodeIdentity(
        JSON.stringify({ Status: "Valid", Subject: "CN=T3 Code", Thumbprint: "" }),
      ),
    ).toBeUndefined();
  });
});

describe("windowsAuthenticodeProbeInput", () => {
  it("passes the helper path outside the PowerShell command text", () => {
    const helperPath = "C:\\Program Files\\T3 Code\\T3CodeComputerUse.exe";

    expect(windowsAuthenticodeProbeInput(helperPath)).toEqual({
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$signature = Get-AuthenticodeSignature -LiteralPath $env:T3CODE_COMPUTER_USE_HELPER_PATH",
          "$certificate = $signature.SignerCertificate",
          "[pscustomobject]@{ Status = [string]$signature.Status; Subject = $certificate.Subject; Thumbprint = $certificate.Thumbprint } | ConvertTo-Json -Compress",
        ].join("; "),
      ],
      env: { T3CODE_COMPUTER_USE_HELPER_PATH: helperPath },
      timeout: "10 seconds",
      maxOutputBytes: 64 * 1_024,
    });
  });
});
