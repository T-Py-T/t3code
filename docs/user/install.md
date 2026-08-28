# Install T3 Code

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

## Providers

T3 Code drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                     | Default binary | Log in with                |
| ---------- | ------------------------------------------------------- | -------------- | -------------------------- |
| Atomic     | [Atomic](https://github.com/bastani-inc/atomic)         | `atomic`       | Model provider credentials |
| Pi         | [Pi coding agent](https://github.com/earendil-works/pi) | `pi`           | Model provider credentials |
| Oh My Pi   | [Oh My Pi](https://github.com/can1357/oh-my-pi)         | `omp`          | Model provider credentials |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)    | `codex`        | `codex login`              |
| Claude     | [Claude Code](https://claude.com/product/claude-code)   | `claude`       | `claude auth login`        |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                    | `cursor-agent` | `agent login`              |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                      | `grok`         | `grok login`               |
| OpenCode   | [OpenCode](https://opencode.ai)                         | `opencode`     | `opencode auth login`      |

Codex and Claude are on by default. Atomic, Pi, Oh My Pi, Cursor, Grok Build, and OpenCode are off by default;
turn them on in **Settings** → the provider's card when you want to use them.

Install the Pi-compatible providers with npm when you want either of them:

```bash
npm install --global @earendil-works/pi-coding-agent
npm install --global @bastani/atomic
npm install --global @oh-my-pi/pi-coding-agent
```

Pi 0.84.3 or newer and Oh My Pi 18.0.8 or newer are recommended. Atomic, Pi, and Oh My Pi discover the models and credentials configured in
their own agent directories. T3 Code does not copy or manage those credentials.

### Oh My Pi workflow and agent visibility

Oh My Pi chat, thinking, tool activity, phased todos, and child agents render in the normal T3
conversation and **Agents** panel. Open a child's **transcript** to follow its JSONL session while it
runs. Use **Stop all** to interrupt the active parent workflow. A message sent during a run steers it;
use `/follow-up <message>` to queue work for after the current OMP turn instead.

OMP project workflow commands created under `.omp/commands/*.md` get a contained **{} script**
viewer. Ambient extension/plugin code is disabled by default. Enabling **Load ambient extensions**
runs that code with the T3 server's permissions. OMP may still discover project skills, rules,
prompts, and settings; use an isolated OMP agent directory when you need a stronger trust boundary.
The complete capability and validation matrix is in [Oh My Pi provider](../internals/providers-omp.md).

### Atomic Workflow Visibility

In the web and desktop clients, Atomic workflow runs appear in the **Agents** panel with live stage
status, dependency order, summaries, and an **Awaiting input** state. When the workflow has a `.js`
or `.ts` script in the current workspace's `.atomic/workflows` directory, **{} script** opens its
contained, read-only source.

To load workflows from the current workspace, enable **Settings** → **Atomic** → **Trust project
resources** for that Atomic instance. It is off by default. Enabling it also allows Atomic to load
other project-local skills, extensions, prompts, packages, and settings. Only enable it for a
workspace you trust: extensions and workflow tools run with the permissions of the T3 Code server.
You can still inspect workflow source through T3's contained, read-only viewer after Atomic reports
the run.

Atomic's parent RPC stream does not include private child-stage reasoning or tool transcripts, so
T3 Code reports only the workflow lifecycle and summary details Atomic publishes.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run the login command on the machine running the T3 Code server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and reports its authentication or configuration
guidance if a session cannot start.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
