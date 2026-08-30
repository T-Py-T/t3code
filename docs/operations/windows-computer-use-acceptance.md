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

Capture the expected helper SHA-256 from the signed release staging output before installation. The
Electron updater manifest hashes the outer installer, not the nested helper, so it is not the source
for this value. Run PowerShell as the same Windows user that runs T3 Code:

```powershell
$app = "C:\Users\me\AppData\Local\Programs\t3code\T3 Code (Alpha).exe"
$expectedHelperHash = "<SHA-256 CAPTURED FROM SIGNED RELEASE STAGING>"
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
completed action count, accessibility element count, screenshot size, and the Notepad marker. The
script opens a uniquely named temporary document and selects that exact target so an older dirty
Notepad window cannot contaminate the result. Keep the JSON and release logs as bounded evidence;
do not copy screenshot bytes or raw accessibility trees into product events.

## Provider and client checklist

For Codex, Pi, Atomic, and Oh My Pi, repeat the same user-visible scenario:

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

Oh My Pi must additionally preserve phased todo status, detached-child status, and the child
transcript affordance while an approval is pending. Its provider run must use OMP 18.0.9 or the
current pinned acceptance version.

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

The review-hardening rerun rebuilt the helper from the branch after expanding the terminal deny
list. .NET formatting, build, all eight native tests, ARM64 publication, package probes, and helper
attachment passed. The disposable development-signed helper had SHA-256
`639EB6EFAF24B948ECB244E10E836371FF2FE92D074116A9A7FEEFFB86D95F38`; a clean interactive Notepad
run completed five actions, returned distinct pre/post observation IDs, exposed 44 accessibility
elements, and captured a 26,092-byte PNG. This hash documents only that UTM run and is not a release
identity.

The final branch-candidate run built and installed T3 Code Alpha 0.0.37 for Windows ARM64 from
commit `be08913f9`. The installed desktop host and helper were both signed with the same disposable
UTM certificate, proving the packaged same-publisher trust check; the installed host SHA-256 was
`546034BD1F893014F3F2E1134CDF3BC7DD4CAE5BF3BDB5ADA825CB917C1B244B` and the helper SHA-256 was
`93E07334A61143B6B05DB657723BDAD735070F6FE3947D8642BDEAA4C0110A18`. Package validation reported
version 0.0.37, a valid attached helper, and successful server-sidecar and native file-finder probes.
A fresh interactive Notepad run completed five actions, exposed 44 accessibility elements, captured
a 49,949-byte PNG, and returned distinct pre/post observation IDs. These hashes record the modified
development-signed installation only; the unsigned development installer is not a release artifact.

The post-review native rerun used helper commit `717f2fc0b` in the same Windows 11 ARM64 guest. It
passed .NET formatting, Release build, all eight native tests, self-contained ARM64 publication,
and development signing. The resulting helper SHA-256 was
`BBA98639260D89228711BB1E71595063A8CAF8E5F576CD53F6294ED92733B194`. It replaced the helper in
the installed T3 Code Alpha 0.0.37 package and passed the packaged server, native file-finder,
valid-signature, same-session, and parent-process attachment checks. A new interactive Notepad run
completed all five actions, exposed 44 accessibility elements, captured a 38,345-byte PNG, and
returned distinct pre/post observation IDs. This rerun validates the current native helper changes;
the installed outer application remains the development package recorded above rather than a new
production-signed release artifact.

The 2026-08-30 fork release run installed T3 Code Alpha `0.0.35-devnext.5eb5a68` from fork
`dev/next-release` commit `5eb5a6838` in Windows 11 Pro ARM64 build 26200. Cold Authenticode chain
validation of the valid helper exceeded the former 10-second process limit, so the server rejected
the helper before startup. The bounded signature probe was raised to 30 seconds; publisher matching
and failure behavior were unchanged. The installed server archive used to verify the fix had
SHA-256 `0C13C992B10E83F44B565D159C6D778AEC56BA2F7E37526E7CA39094132A81ED`. Package acceptance then
passed with app version `0.0.35-devnext.5eb5a68`, the server-sidecar and native file-finder probes,
and an attached same-session helper signed by the disposable publisher
`CN=T3 Code Fork UTM Acceptance 5eb5a68`; its SHA-256 was
`B64294BED517AB7F1D11B508F1E883FBE5DCF86C4F6656393A94850D8AC16BAD`. The hardened interactive
test addressed a unique Notepad document, completed click, Ctrl+A, text entry, clipboard paste, and
wait, exposed 46 accessibility elements, and captured a 28,207-byte PNG. These signatures and hashes
are development evidence only and make no production-signing claim.

## Remaining release gates

UTM is required development evidence, not the complete Windows release gate. Before general
availability, retain evidence for:

- a production-signed artifact on physical Windows hardware;
- multiple displays, scaling, sleep/wake, and foreground-input latency;
- local and explicitly scoped T3 Connect clients;
- stop, takeover, helper crash, app exit, lock, reconnect, and competing-lease recovery;
- persistent grant revocation and migration;
- every required pointer, keyboard, structured accessibility, browser, and Office operation;
- desktop, web, and mobile parity.

T3 must continue to fail closed on UAC secure desktop, Windows privacy prompts, terminal targets,
and T3 Code itself.
