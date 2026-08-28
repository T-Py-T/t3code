# Permission Modes

A permission mode controls how much the agent does on its own and when it stops to ask you.

The mode is set per thread, from the mode control in the message composer. Changing it in one
thread does not change any other thread. A thread created from inside another thread keeps that
thread's mode; otherwise new threads start in **Full access** unless you pick something else
before sending.

## The Modes

**Supervised**: ask before commands and file changes. The agent pauses and shows you what it
wants to run or edit, and waits for approval. Work outside the workspace is restricted.

**Auto-accept edits**: auto-approve edits, ask before other actions. File changes go through
without prompting; commands and anything else still stop for approval.

**Auto**: routine actions proceed without you; risky ones still ask. How this is enforced depends
on the provider: Codex delegates routine approvals to an AI reviewer, Claude uses its own auto
permission mode, and providers without an equivalent (such as OpenCode) fall back to asking, like
Supervised.

**Full access**: allow commands and edits without prompts. The default. The agent runs
unattended until it finishes or asks a question of its own.

Approvals appear inline in the conversation. Approve or reject one and the agent continues from
there.

For Grok, **Always allow this session** remembers the matching command or tool input. Other
actions still ask for approval. It does not change the thread to **Full access**.

## Computer Use

Computer Use permissions are separate from the thread's permission mode. **Full access** never
bypasses an app grant or a point-of-risk confirmation.

Computer Use is a feature-complete preview for unlocked native-app and browser workflows. Native
release signing, physical-platform acceptance, in-app macOS permission setup, Office add-in parity,
and unattended locked use remain outside that supported preview scope. On web or desktop, turn on
**Settings** → **Integrations** → **Computer Use (preview)** before starting a new Codex, Pi,
Atomic, or Oh My Pi session. The setting is off by default, and an existing session keeps the tools it started
with. T3 Code asks separately before observing or operating an app. An app grant can last
for one action, the current turn, the provider session, or permanently on that verified computer.
Actions that may have an external effect require another confirmation immediately before execution.

Native app control requires an environment hosted by the T3 Code desktop app on macOS or Windows;
a CLI-only server reports that no native host is available. Web and mobile can still direct a
desktop-hosted environment remotely.

Desktop, web, and mobile show the same inline approvals and Computer Use timeline activity. An
active card can pause, stop, or release control for human takeover. These controls end active input
and prevent another agent action until you choose **Resume** or **Allow a new action**. Taking over
from a remote client does not create a remote-desktop input channel; interact on the environment
machine when physical control is required.

A web or mobile client paired before its server gained Computer Use keeps its original authorization
scopes. Pair that client again if it can see the environment but cannot use the Computer Use
approval or lifecycle controls.

Web, desktop, and mobile thread settings also show the connected native host and recent bounded
activity metadata, and all three can clear that history. Web and desktop settings additionally show
permanent app grants and let you revoke them. Activity metadata is retained for 30 days. Screenshots,
page contents, accessibility trees, clipboard values, and typed text are not kept in the history.

On macOS, T3 settings show the exact native helper identity and its current Accessibility, Screen
Recording, and Input Monitoring state. The preview does not yet include an **Open System Settings**
shortcut. Missing permissions are also reported through the Computer Use tool result and must be
granted manually in macOS System Settings; T3 never clicks or approves a privacy prompt for you.

## Browser Tools

Agent access to the in-app preview browser is on by default. On web or desktop, turn **Agent browser
access** off under **Settings** → **Integrations** → **Browser** to withhold the `preview_*` tools
from new Codex, Pi, Atomic, and Oh My Pi sessions. Your own browser panel remains available, and a session that
is already running keeps the tools it started with.

The desktop app can also open a dedicated, persistent T3 Code browser profile for sites that require
a sign-in. **Signed-in browser access** is off by default and never attaches to your
everyday Chrome profile. Enable it under the same Browser settings, choose **Open browser**, and sign
in only to the sites you want that profile to use. Disabling access closes the controlled browser;
external-browser recording is not supported in the preview.

Both browser routes use the same app-grant, point-of-risk confirmation, lifecycle, and metadata
history policy as native Computer Use. The browser settings and native **Computer Use** switch are
independent, so disabling native app control does not silently disable the governed preview tools.

## Choosing a Mode

Use **Full access** for work in a worktree or a sandbox you can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes onto its own approval and sandbox settings. Codex, for example,
translates the mode into its approval policy and sandbox level, so **Supervised** runs the CLI
with prompting enabled and a restricted workspace while **Full access** disables both. Grok
threads do the same: **Supervised** starts Grok in ask mode even if your Grok CLI config is
set to always-approve, and **Full access** starts Grok with always-approve. The labels above
describe what you get; the exact per-provider translation is internal and may change.

Pi and Atomic currently offer only **Full access** because their session protocol has no generic
provider approval callback. Oh My Pi offers **Approval required** through OMP's `always-ask` mode
and **Full access** through its configured approval mode. T3-owned Computer Use app grants and
action confirmations still apply through the bundled T3 extension in either mode.

For providers that support them, mobile offers the same modes with the same labels and descriptions.
