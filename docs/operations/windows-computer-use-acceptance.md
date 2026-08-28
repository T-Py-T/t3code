# Windows Computer Use acceptance

Use this runbook to validate the packaged Windows Computer Use helper before a release candidate is
promoted. Run it inside the Windows desktop session that owns the T3 environment. A service account,
the UTM host, or a remote shell must not substitute for the interactive Windows user during UI
Automation and input tests.

## What the checks prove

The acceptance is layered so a failure identifies the broken boundary:

1. The package check verifies the expected application, signed helper, resource monitor, server
   sidecar, native file finder, process identity, and Windows host details.
2. The native interactive check discovers Notepad, captures a PNG, reads its UI Automation tree,
   moves foreground focus, clicks, types, pastes, waits, and validates a fresh observation.
3. The provider check runs `computer_status`, `computer_list_targets`, `computer_observe`, and
   `computer_act` through the T3 toolkit from each supported provider. It must visibly stop for the
   app grant and point-of-risk confirmation.
4. Client checks confirm that desktop, web, and mobile show the same target, progress, approval,
   completion, history, stop, and takeover state.

The package stages only `T3CodeComputerUse.exe`. The helper must therefore publish with
`IncludeNativeLibrariesForSelfExtract=true`; otherwise basic status and target discovery can work
while screenshot capture and UI Automation fail on Windows ARM64 because the WPF native libraries
are absent.

## Package check

Obtain the expected signed helper SHA-256 from the release manifest. Run PowerShell as the same
Windows user that runs T3 Code:

```powershell
$app = "C:\Users\me\AppData\Local\Programs\t3code\T3 Code (Alpha).exe"
$expectedHelperHash = "<SHA-256 FROM THE RELEASE MANIFEST>"
$evidence = "C:\Users\Public\t3-package-acceptance"

.\native\computer-use-windows\Tests\RunPackagedAcceptance.ps1 `
  -AppExecutable $app `
  -ExpectedHelperSha256 $expectedHelperHash `
  -EvidenceDirectory $evidence `
  -RequireValidHelperSignature `
  -RequireRunningApp `
  -RequireRunningHelper
```

The command writes `acceptance.json` and bounded probe output under the evidence directory. A local
test certificate can exercise the verification path during development, but it does not satisfy the
production publisher or signing-reputation gate.

## Native interactive check

Run this from the signed-in interactive desktop, with privileged prompts and terminal windows out of
scope:

```powershell
$helper = "C:\Users\me\AppData\Local\Programs\t3code\resources\computer-use\T3CodeComputerUse.exe"
$output = "C:\Users\Public\t3-windows-interactive-acceptance.json"

.\native\computer-use-windows\Tests\RunInteractiveIntegration.ps1 `
  -HelperPath $helper `
  -OutputPath $output
```

A passing result records the stable target identity, initial and post-action observation IDs,
completed action count, accessibility element count, screenshot size, and the Notepad marker. Keep
the JSON and release logs as bounded evidence; do not copy screenshot bytes or raw accessibility
trees into product events.

## Provider and client checklist

For Codex, Pi, and Atomic, repeat the same user-visible scenario:

- call `computer_status` and verify the signed Windows host identity;
- list targets and choose an allowed Notepad window by stable target ID;
- request an observation and verify the inspect app-grant choices;
- request a reversible local action and verify the separate operate grant;
- confirm the point-of-risk boundary immediately before execution;
- verify Notepad receives focus and the requested text;
- verify the tool returns `completedActions` plus a fresh observation;
- stop or take over during a second action and verify synthetic input is released;
- verify metadata history contains requested, waiting, and terminal states without screen contents;
- verify desktop, web, and mobile project the same lifecycle.

Atomic must additionally preserve workflow and stage correlation while an approval is pending.
Ordinary chat and workflow progress must continue to render during the wait.

## UTM development evidence

The 2026-08-28 development run used Windows 11 Pro ARM64 build 26200 in UTM, T3 Code Alpha 0.0.36,
and Pi 0.84.3. The installed helper was signed with the disposable local publisher
`CN=T3 Code Computer Use UTM Acceptance`; this is intentionally not a production signing claim.

The run passed:

- packaged server and native file-finder probes;
- signed helper verification and same-session host connection;
- status and discovery of seven native targets;
- PNG observation and a 44-element Notepad UI Automation tree;
- foreground transfer from T3 Code to Notepad;
- a five-action native sequence covering click, Ctrl+A, text entry, clipboard paste, and wait;
- the real T3 → Pi extension → MCP toolkit → policy → signed Windows helper path;
- visible inspect, operate, and external-side-effect approval boundaries;
- two completed Pi actions with a fresh post-action PNG and accessibility tree.

The deterministic local model used in that provider test selected a fixed tool sequence only. The
real Pi executable, T3 Pi extension, MCP transport, policy, UI, broker, signed helper, UI Automation,
capture, and native input paths all ran normally.

## Remaining release gates

UTM is required development evidence, not the complete Windows release gate. Before declaring the
feature complete, retain evidence for:

- a production-signed artifact on physical Windows hardware;
- multiple displays, scaling, sleep/wake, and foreground-input latency;
- local and explicitly scoped T3 Connect clients;
- stop, takeover, helper crash, app exit, lock, reconnect, and competing-lease recovery;
- persistent grant revocation and migration;
- every required pointer, keyboard, structured accessibility, browser, and Office operation;
- desktop, web, and mobile parity.

T3 must continue to fail closed on UAC secure desktop, Windows privacy prompts, terminal targets,
and T3 Code itself.
