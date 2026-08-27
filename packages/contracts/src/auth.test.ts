import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  AuthAdministrativeScopes,
  AuthComputerApproveScope,
  AuthComputerHostScope,
  AuthComputerOperateScope,
  AuthComputerReadScope,
  AuthDesktopClientScopes,
  AuthEnvironmentScope,
  AuthStandardClientScopes,
} from "./auth.ts";

const decodeScope = Schema.decodeUnknownSync(AuthEnvironmentScope);
const computerScopes = [
  AuthComputerReadScope,
  AuthComputerOperateScope,
  AuthComputerApproveScope,
  AuthComputerHostScope,
] as const;

describe("Computer Use authorization scopes", () => {
  it("decodes each dedicated scope", () => {
    expect(computerScopes.map((scope) => decodeScope(scope))).toEqual([
      "computer:read",
      "computer:operate",
      "computer:approve",
      "computer:host",
    ]);
  });

  it("does not silently grant Computer Use through existing client defaults", () => {
    for (const scope of computerScopes) {
      expect(AuthStandardClientScopes).not.toContain(scope);
      expect(AuthAdministrativeScopes).not.toContain(scope);
    }
  });

  it("grants only the local desktop control surface the user-facing computer scopes", () => {
    expect(AuthDesktopClientScopes).toEqual([
      ...AuthAdministrativeScopes,
      AuthComputerReadScope,
      AuthComputerOperateScope,
      AuthComputerApproveScope,
    ]);
    expect(AuthDesktopClientScopes).not.toContain(AuthComputerHostScope);
  });
});
