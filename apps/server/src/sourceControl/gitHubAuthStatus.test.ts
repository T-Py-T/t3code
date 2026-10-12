import { describe, expect, it } from "@effect/vitest";

import {
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
} from "./gitHubAuthStatus.ts";

describe("parseGitHubAuthStatus", () => {
  it("returns parsed accounts for valid gh auth status JSON", () => {
    const json = JSON.stringify({
      hosts: {
        "github.com": [
          {
            state: "success",
            active: true,
            host: "github.com",
            login: "octocat",
          },
        ],
      },
    });

    expect(parseGitHubAuthStatus(json)).toEqual({
      parsed: true,
      accounts: [
        {
          host: "github.com",
          account: "octocat",
          authenticated: true,
          active: true,
          error: null,
        },
      ],
    });
  });

  it("marks invalid JSON as unparsed with no accounts", () => {
    expect(parseGitHubAuthStatus("not-json")).toEqual({ parsed: false, accounts: [] });
  });

  it("skips accounts missing host or login", () => {
    const json = JSON.stringify({
      hosts: {
        "github.com": [{ state: "success", active: true, host: " ", login: "ghost" }],
      },
    });

    expect(parseGitHubAuthStatus(json).accounts).toEqual([]);
  });
});

describe("findAuthenticatedGitHubAccount", () => {
  it("prefers an authenticated active account", () => {
    const accounts = [
      {
        host: "github.com",
        account: "inactive",
        authenticated: true,
        active: false,
        error: null,
      },
      {
        host: "github.com",
        account: "active",
        authenticated: true,
        active: true,
        error: null,
      },
    ];

    expect(findAuthenticatedGitHubAccount(accounts)?.account).toBe("active");
  });
});
