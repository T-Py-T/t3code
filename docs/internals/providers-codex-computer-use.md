# Codex Computer Use

> For maintainers. For setup and behavior, see
> [Codex: Use apps on the T3 host Mac](../user/providers-codex.md#use-apps-on-the-t3-host-mac).

T3 Code can attach OpenAI's signed macOS Computer Use MCP client to a Codex provider session. This
is an OpenAI Computer Use bridge, not a T3-owned accessibility host. The feature deliberately
reuses the Codex app-server transport and T3's existing MCP elicitation approval projection instead
of adding a second desktop-control protocol.

The feature-complete T3-owned replacement is defined in the
[T3 Computer Use specification](./computer-use.md). This document describes only the current bridge
and its verified limits.

## User and process flow

1. The user enables **OpenAI Computer Use bridge** on one Codex provider instance.
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

User-configured MCP servers remain independent. The switch means “attach the OpenAI bridge client,”
not “remove every other route that might automate the computer.”

## Permission and process ownership

The T3 server launches the OpenAI-signed `SkyComputerUseClient` as a child of the Codex app server.
That client connects to the separately signed `SkyComputerUseService` through OpenAI's group
container. On the verified macOS installation, the service was a child of ChatGPT rather than T3.

macOS System Settings listed **Codex Computer Use** under both Accessibility and Screen & System
Audio Recording; it did not list T3 Code. Code signing likewise identified the client as
`com.openai.sky.CUAService.cli` from OpenAI's team. Seeing T3 Code in `list_apps` only proves the
OpenAI helper can target T3's UI. It does not transfer system permission ownership to T3.

Consequences:

- the OpenAI desktop service must remain available for the current bridge to operate;
- T3 cannot grant, revoke, or display the authoritative macOS permission state;
- a T3-owned implementation requires a T3-signed desktop helper and IPC endpoint;
- a stable distributable build needs a stable signing identity so macOS permission grants survive
  app updates.

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

## ChatGPT Computer Use parity

Validated on macOS on August 27, 2026. “Inherited” means the behavior comes from OpenAI's helper,
not from a T3 implementation.

| Capability                                      | Status          | Evidence or gap                                                                                                                                                           |
| ----------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App discovery                                   | Pass, inherited | `list_apps` returned TextEdit, T3 Code, and the other running apps.                                                                                                       |
| Accessibility-tree inspection                   | Pass, inherited | `get_app_state` returned structured accessibility text.                                                                                                                   |
| Screenshot inspection                           | Pass, inherited | The same state call returned a screenshot and T3 rendered the tool lifecycle.                                                                                             |
| Click and text entry                            | Pass, inherited | A live TextEdit run clicked the editor and entered a unique marker.                                                                                                       |
| Keyboard navigation                             | Partial         | `press_key` completed, but the Return-key newline was not verified in TextEdit.                                                                                           |
| Clipboard paste                                 | Missing         | The exposed Computer Use MCP catalog has no dedicated paste action.                                                                                                       |
| Selection and direct value setting              | Pass, inherited | `select_text` and `set_value` both changed the TextEdit editor as expected.                                                                                               |
| Scroll, drag, and secondary actions             | Pass, inherited | The test changed scroll position, moved the window, and invoked its exposed Raise action.                                                                                 |
| Background macOS app operation                  | Pass, inherited | Calculator and TextEdit were operated without making them the T3 client surface.                                                                                          |
| Cross-app workflow                              | Partial         | Multiple apps can be targeted, but no complete multi-app workflow was exercised.                                                                                          |
| Per-app approval cards                          | Partial         | T3 maps MCP elicitations, but the live TextEdit run produced no new approval prompt. The approval store and policy remain OpenAI-owned.                                   |
| Sensitive-action confirmations                  | Partial         | T3 can project Codex requests, but has no independent Computer Use risk policy.                                                                                           |
| Stop and take over                              | Partial         | A provider turn can be interrupted, but ChatGPT's dedicated takeover experience was not reproduced.                                                                       |
| Remote web/mobile direction                     | Partial         | A remote T3 client can direct the host session, but the host still depends on OpenAI's local service.                                                                     |
| T3-owned Accessibility and Screen Recording     | Missing         | System Settings grants both capabilities to Codex Computer Use, not T3 Code.                                                                                              |
| Operation without ChatGPT/Codex desktop service | Missing         | The privileged service was hosted by ChatGPT and the MCP client connected to its IPC socket.                                                                              |
| Computer Use settings and permission management | Missing         | T3 has only an enable switch; it has no Any App, always-allowed-app, revocation, browser, or add-in settings.                                                             |
| Locked-computer use                             | Missing         | T3 has no trusted unlock or locked-use implementation.                                                                                                                    |
| Windows computer use                            | Missing         | The integration discovers only the signed macOS client.                                                                                                                   |
| Excel and PowerPoint add-ins                    | Missing         | T3 does not integrate the ChatGPT add-ins.                                                                                                                                |
| First-class `@Computer` and `@AppName` mentions | Missing         | T3 relies on natural-language tool selection.                                                                                                                             |
| Browser extension/semantic browser control      | Missing         | Native GUI accessibility can target a browser, but T3 does not bridge ChatGPT's browser extension. T3's collaborative preview browser is a separate local-web capability. |

For browser actions that do not need a visible screenshot, use a separate semantic browser
integration (extension, browser protocol, or T3 collaborative preview) and keep accessibility-based
Computer Use as the general desktop fallback.

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

A second integrated pass used TextEdit to exercise app discovery, accessibility text, screenshots,
clicking, text entry, selection, direct value setting, scrolling, window dragging, and a secondary
accessibility action. It left the document unsaved and then read T3 Code's accessibility state
without interacting with it. That run exposed the keyboard-newline and missing-paste gaps recorded
above.

Official reference: [ChatGPT Computer Use](https://learn.chatgpt.com/docs/computer-use) and the
[OpenAI computer-use tool guide](https://developers.openai.com/api/docs/guides/tools-computer-use).
