# Oh My Pi provider

T3 Code integrates [Oh My Pi (OMP)][omp] as the built-in `omp` provider. OMP is based on the Pi
coding-agent runtime, but its RPC v2 protocol adds lossless chunking, richer subagent events,
phased todos, local-command output, and a terminal-session lifecycle that differs from Pi and
Atomic. The implementation intentionally shares the proven Pi adapter where the protocols match
and isolates OMP-specific behavior behind `OmpDriver`, `OmpProvider`, and `OmpAdapter` definitions.

OMP is Early Access, off by default, and session-only. It does not provide T3's auxiliary branch
name, commit message, pull-request text, or thread-title generation. OMP 18.0.8 or newer is required;
18.0.9 is the pinned acceptance version for this integration.

## User-visible experience

- **Oh My Pi** is selectable in new-thread and provider-instance pickers on web, desktop, and
  mobile.
- Models, reasoning levels, slash commands, skills, and command input hints come from the running
  OMP installation rather than a T3-maintained catalog.
- Assistant text, thinking, tool starts/updates/results, extension warnings, retry notices, and
  automatic compaction render through the ordinary T3 timeline.
- Phased OMP todos render as a live workflow graph in **Agents**, including blocked, waiting,
  running, completed, and abandoned tasks.
- OMP task children render as live Agents rows with role, model, current tool, elapsed time, token
  and tool counts, status, and their contained JSONL transcript.
- **Stop all** interrupts the parent turn and its active workflow. Sending a message during a run
  steers it by default; `/follow-up <message>` queues work after the current turn and
  `/steer <message>` makes the choice explicit.
- A project workflow command written under `.omp/commands/*.md` is attached to the workflow run.
  The workflow source action opens its contained, read-only code in the Agents panel.
- OMP extension `confirm`, `select`, `input`, and `editor` requests become ordinary T3 input cards.
  OMP's `always-ask` approval mode backs T3's **Approval required** runtime mode.
- Image attachments use OMP RPC image content. Browser and native Computer Use are delivered by
  the same private T3 toolkit used by Pi and Atomic, with T3-owned grants and point-of-risk policy.

## Protocol contract

The process starts as `omp --mode rpc`, receives `PI_CODING_AGENT_DIR` when configured, and
immediately negotiates protocol v2. `AtomicRpcProcess` reassembles `rpc_chunk` sequences with strict
index, count, byte-length, base64, UTF-8, JSON, and maximum-size validation. A malformed or
interleaved chunk sequence fails the provider session instead of producing partial output.
OMP does not accept Pi's `--name` launch flag, so T3 names a thread's OMP session with the
`set_session_name` RPC command after negotiation.

OMP acknowledges `prompt` before the agent finishes. T3 therefore keeps the provider turn open
until a terminal `agent_end`. A parent `agent_end` is not enough while a detached child remains in
the OMP subagent registry: T3 waits for the child to settle and for OMP's subsequent resumed-parent
terminal cycle. This prevents the thread from showing completion while detached workflow work is
still running. Projected todo workflows also carry a session-unique run identity, so stopping and
restarting the provider cannot reactivate or overwrite an older completed workflow in Agents.

Local slash commands may never start an agent. Their `command_output` becomes assistant chat and
`prompt_result.agentInvoked=false` settles the T3 turn. Automatic compaction accepts both the
Pi-compatible `compaction_*` names and OMP's `auto_compaction_*` names.

## Settings and trust

The provider settings expose:

- binary path (default `omp`);
- optional isolated `PI_CODING_AGENT_DIR`;
- ambient extension loading (off by default);
- OMP approval mode (`always-ask`, `write`, or `yolo`; default `write`);
- additional launch arguments; and
- multiple independently configured instances.

The extension switch adds `--no-extensions` when off. T3's explicitly supplied private Browser and
Computer Use extension still loads for enabled environment capabilities. OMP can continue to
discover project skills, rules, prompts, and settings even with ambient extensions disabled;
operators who need a stronger boundary should use an isolated agent directory and a trusted
workspace. Explicit approval flags in launch arguments override the provider setting.

## Harness validation matrix

This matrix is derived from the OMP 18.0.9 RPC and feature documentation. **Pass** means the
capability is available to a T3 user; it may use an ordinary timeline/tool/slash-command surface
rather than a bespoke card. Release acceptance requires every Core group and at least 18 of 20
groups. The implemented score is **19/20 (95%)**, with every Core group covered.

|   # | Harness capability group                  | Tier     | Result  | T3 surface and evidence                                                                             |
| --: | ----------------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------- |
|   1 | Discovery and setup                       | Core     | Pass    | Built-in driver, settings schema, version gate, isolated agent dir, RPC health probe                |
|   2 | Chat and streaming                        | Core     | Pass    | Text deltas, authoritative message end, local command output, terminal turn settlement              |
|   3 | Thinking                                  | Core     | Pass    | Discovered reasoning levels and `thinking_delta` reasoning items                                    |
|   4 | Tool lifecycle                            | Core     | Pass    | Start, update, completion, errors, result detail, and raw bounded tool data                         |
|   5 | Approvals and extension UI                | Core     | Pass    | Confirm/select/input/editor cards, answer/cancel lifecycle, `always-ask` mode                       |
|   6 | Abort, steer, follow-up, interrupt        | Core     | Pass    | Composer steering, `/steer`, `/follow-up`, and Agents **Stop all**                                  |
|   7 | Models and providers                      | Core     | Pass    | Live model discovery, provider/model selection, reasoning capability map                            |
|   8 | Slash commands                            | Core     | Pass    | Live OMP command discovery, descriptions, input hints, and local output                             |
|   9 | Sessions                                  | Core     | Pass    | One isolated OMP session per T3 thread, session identity/cursor, stop/restart, OMP session commands |
|  10 | Branch, handoff, export                   | Standard | Pass    | OMP-discovered slash commands and their output are usable from the T3 composer                      |
|  11 | Todos and workflows                       | Core     | Pass    | Phased todo graph, dependencies, blocked/waiting state, and terminal workflow status                |
|  12 | Workflow creation                         | Core     | Pass    | Generated `.omp/commands/*.md` code in the read-only source viewer and write tool card              |
|  13 | Subagent lifecycle                        | Core     | Pass    | Start/progress/complete/fail/abort mapped to native Agents tasks                                    |
|  14 | Subagent transcript and control           | Core     | Pass    | Contained JSONL transcript viewer, metrics, current tool, parent linkage, stop control              |
|  15 | Background jobs and collaboration         | Standard | Pass    | Detached children remain live; command/tool output and collaboration activity stay in the thread    |
|  16 | Context, usage, compaction, retry         | Standard | Pass    | Usage metrics, context compaction items, retry notices, terminal errors                             |
|  17 | Skills, rules, extensions, plugins        | Core     | Pass    | Skill discovery, slash insertion, extension loading switch, extension errors, reload commands       |
|  18 | Coding harness tools                      | Standard | Pass    | Read/write/edit/bash/search/LSP/eval/task and other tools share the dynamic tool card lifecycle     |
|  19 | Browser, web, images, Computer Use        | Core     | Pass    | Image prompts, OMP tools, and the policy-governed T3 Browser/Computer Use toolkit                   |
|  20 | Memory, checkpoint, rewind, advisor, TTSR | Standard | Partial | OMP tools/commands remain callable and visible, but T3 has no dedicated advisor or TTSR status card |

## Automated acceptance

Focused tests cover the protocol and all custom seams:

- `AtomicRpcProcess.test.ts`: RPC v2 negotiation and adversarial chunk reassembly;
- `OmpProvider.test.ts`: version, environment, model, command, skill, steer, and follow-up discovery;
- `OmpAdapter.test.ts`: governed launch, detached settlement, approvals, todos, workflow source,
  transcripts, metrics, compaction, consecutive plans, local commands, steering, follow-up, and
  interruption;
- `OmpCliProbe.test.ts`: opt-in discovery and model-backed streaming through a real OMP install;
- `workflowScriptQuery.test.ts`: contained OMP Markdown source and JSONL transcript reads plus symlink
  escape rejection, exact selected-thread artifact authorization, and cross-thread transcript
  rejection;
- `ComputerUseToolkit.test.ts`: OMP uses the same policy-governed toolkit contract as Codex, Pi,
  and Atomic;
- contract, web metadata, transcript formatter, and built-in-driver tests: cross-client selection and
  wire compatibility.

The pinned 18.0.9 live probe negotiated RPC v2, discovered 119 models and 59 slash commands, enabled
full subagent event forwarding, named the session through RPC, streamed `OMP_T3_ADAPTER_OK` through
the T3 adapter, and observed a terminal completed turn. A second live acceptance run projected
phased todos and a detached child through the T3 adapter, then verified that every workflow row and
the parent turn settled. Run it against a configured OMP install with:

```bash
T3_OMP_BINARY_PATH=/path/to/omp T3_OMP_LIVE_TURN=1 \
  vp test run apps/server/src/provider/Layers/OmpCliProbe.test.ts
```

Before merge, the branch must additionally pass the repository pre-commit gate, Greptile-style
review, the full local Actions workflow through ACT/Podman, and a live OMP 18.0.9 session. Live
acceptance must exercise ordinary chat/thinking/tools, an approval, a phased `workflowz` task with a
detached child, transcript opening, `/follow-up`, interruption, and Browser/Computer Use discovery.

## Known boundaries

- OMP's interactive terminal widgets are represented by T3's timeline, command output, settings,
  input cards, and Agents surfaces; T3 does not embed the OMP TUI.
- The Agents transcript reader accepts the default `~/.omp/agent/sessions` root. A custom agent
  directory can run OMP, but its child transcript is not exposed until that root is explicitly
  admitted to the contained artifact service.
- Dynamic command updates after a session starts do not currently rebuild the provider snapshot;
  reload the provider instance to refresh the composer catalog.
- Auxiliary Git/title text generation remains intentionally unsupported.

[omp]: https://github.com/can1357/oh-my-pi
[rpc]: https://github.com/can1357/oh-my-pi/blob/v18.0.9/docs/rpc.md
[subagents]: https://github.com/can1357/oh-my-pi/blob/v18.0.9/docs/task-agent-discovery.md
[commands]: https://github.com/can1357/oh-my-pi/blob/v18.0.9/docs/slash-command-internals.md
[sessions]: https://github.com/can1357/oh-my-pi/blob/v18.0.9/docs/session-operations-export-share-fork-resume.md
[computer]: https://github.com/can1357/oh-my-pi/blob/v18.0.9/docs/computer-use.md
