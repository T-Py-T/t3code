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

  it("grants user-facing Computer Use scopes to paired remote clients", () => {
    for (const scope of computerScopes.slice(0, 3)) {
      expect(AuthStandardClientScopes).toContain(scope);
      expect(AuthAdministrativeScopes).toContain(scope);
    }
    expect(AuthStandardClientScopes).not.toContain(AuthComputerHostScope);
    expect(AuthAdministrativeScopes).not.toContain(AuthComputerHostScope);
  });

  it("keeps host registration local while desktop and remote clients share controls", () => {
    expect(AuthDesktopClientScopes).toEqual(AuthAdministrativeScopes);
    expect(AuthDesktopClientScopes).not.toContain(AuthComputerHostScope);
  });
});
