import { describe, expect, it } from "@effect/vitest";

import {
  findAuthenticatedGitLabHost,
  parseGitLabAuthStatusHosts,
} from "./gitLabAuthStatus.ts";

describe("parseGitLabAuthStatusHosts", () => {
  it("groups host blocks and extracts logged-in accounts", () => {
    const text = `
gitlab.com
  Logged in to gitlab.com as alice (oauth)

gitlab.example.com:8443
  not logged in
`;

    expect(parseGitLabAuthStatusHosts(text)).toEqual([
      { host: "gitlab.com", account: "alice" },
      { host: "gitlab.example.com:8443", account: null },
    ]);
  });

  it("normalizes host lines to lowercase", () => {
    const text = `GitLab.COM\nLogged in to gitlab.com as bob`;
    expect(parseGitLabAuthStatusHosts(text)[0]?.host).toBe("gitlab.com");
    expect(parseGitLabAuthStatusHosts(text)[0]?.account).toBe("bob");
  });
});

describe("findAuthenticatedGitLabHost", () => {
  it("returns the first host with an account", () => {
    const hosts = [
      { host: "gitlab.com", account: null },
      { host: "gitlab.corp", account: "svc-bot" },
    ];

    expect(findAuthenticatedGitLabHost(hosts)?.host).toBe("gitlab.corp");
  });
});
