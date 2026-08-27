# Codex Computer Use

> For maintainers. For setup and behavior, see
> [Codex: Use apps on the T3 host Mac](../user/providers-codex.md#use-apps-on-the-t3-host-mac).

T3 Code can attach OpenAI's signed macOS Computer Use MCP client to a Codex provider session. The
feature deliberately reuses the Codex app-server transport and T3's existing MCP elicitation
approval projection instead of adding a second desktop-control protocol.

## User and process flow

1. The user enables **T3-managed Computer Use** on one Codex provider instance.
2. `CodexDriver` resolves the shared `CODEX_HOME`, including when the provider uses a shadow home.
3. `CodexComputerUse` checks the standard signed-client location under that shared home.
4. An available client contributes session-local `mcp_servers.computer-use` app-server overrides.
5. The Codex app server starts the client over stdio and discovers its tools.
6. Per-app MCP elicitations are mapped by the existing Codex adapter into T3 approval cards.
7. The approval response returns to the MCP client through the Codex app-server request lifecycle.

The small `CodexComputerUse` interface owns installation discovery, TOML-safe app-server arguments,
and provider warning presentation. The Codex adapter accepts generic additional app-server
arguments; it does not know what Computer Use is. This keeps the desktop-control detail at the
provider seam and leaves orchestration provider-agnostic.

## Installation discovery

The client is expected at:

```text
<shared CODEX_HOME>/computer-use/Codex Computer Use.app/Contents/SharedSupport/
SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient
```

Discovery uses the shared home rather than the effective shadow home because the runtime app is a
shared installation while `auth.json` may be account-specific. Enabling the setting with no client
does not break ordinary Codex chat: the provider reports a warning and contributes no Computer Use
arguments.

T3 never edits the user's Codex `config.toml`. The overrides exist only in the spawned app-server
arguments:

```text
-c mcp_servers.computer-use.command="<absolute client path>"
-c mcp_servers.computer-use.args=["mcp"]
-c mcp_servers.computer-use.enabled=true
```

User-configured MCP servers remain independent. The switch means “attach the T3-managed client,”
not “remove every other route that might automate the computer.”

## Approval and remote semantics

Computer Use operates the machine that owns the T3 environment, not the device rendering the
client. A phone attached to a remote Mac therefore approves and observes access to apps on that
Mac.

The Computer Use MCP client supplies the app name and allowed persistence choices in an
`mcpServer/elicitation/request`. `CodexSessionRuntime` and `CodexAdapter` already preserve those
fields as `mcp_elicitation_approval` requests, so desktop, web, and mobile use the same approval
surface. No permission is inferred from the provider's ordinary sandbox mode.

Computer Use is session configuration. Turning it on or off applies to newly started provider
sessions; a running Codex app-server retains the MCP catalog it started with.

## Boundaries

- macOS only; the signed client is supplied by the Codex or ChatGPT desktop installation.
- Codex only in this slice. Pi does not expose an MCP transport, and Atomic 0.9.13's MCP client does
  not advertise or handle the elicitation requests the signed client uses for new-app approval.
  Attaching the client through either provider would therefore expose a partial, misleading
  capability instead of the same approval lifecycle.
- T3 shows provider tool lifecycle and app-access approvals, but does not duplicate the private
  Computer Use accessibility tree or screenshot stream in a separate panel.
- T3 does not manage macOS Accessibility or Screen Recording permissions. The signed client owns
  that setup and reports pending or denied permission states through its tool results.

## Focused verification

- `CodexComputerUse.test.ts` covers disabled, available, missing-client, path, argument, and warning
  behavior.
- `CodexAdapter.test.ts` verifies additional app-server configuration reaches a new runtime.
- `CodexSessionRuntime.test.ts` ensures a Computer Use-only MCP configuration is not mistaken for
  T3's collaborative preview browser.
- settings contract and provider form tests cover the default-off switch and its visible placement.

An integrated macOS pass attached the signed client, observed its MCP startup transition to ready,
used Calculator through the screenshot/action loop, and rendered every tool lifecycle item in the
T3 thread before the final answer. The agent also recovered from Calculator's pre-existing dirty
state rather than trusting the first screen.
