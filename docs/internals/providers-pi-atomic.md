# Pi and Atomic providers

> For maintainers. For installation and binary discovery, see
> [Install T3 Code](../user/install.md#providers).

T3 Code integrates Pi and Atomic as separate built-in providers over their shared RPC protocol.
Pi is the compatibility baseline. Atomic uses the same chat lifecycle and adds extension events for
workflows and interactive UI.

This document records the adapter contract so the implementation can be maintained in this fork or
proposed upstream without rediscovering the protocol and lifecycle decisions.

## Supported user experience

| Capability                                             | Pi                   | Atomic |
| ------------------------------------------------------ | -------------------- | ------ |
| Create, resume, interrupt, and stop a session          | Yes                  | Yes    |
| Stream assistant text and thinking                     | Yes                  | Yes    |
| Show tool start, updates, results, and failures        | Yes                  | Yes    |
| Discover models, thinking levels, commands, and skills | Yes                  | Yes    |
| Show retries, extension failures, and terminal errors  | Yes                  | Yes    |
| Show context and token usage after a turn              | Yes                  | Yes    |
| Ask select, confirm, input, and editor questions       | Yes                  | Yes    |
| Preserve editor prefill text                           | Yes                  | Yes    |
| Show workflow runs, stages, dependencies, and status   | Protocol events only | Yes    |
| Open contained workflow source from the Agents panel   | No                   | Yes    |

Both providers are Early Access and disabled by default. Pi 0.84.3 or newer is recommended. Pi
0.84.0 through 0.84.2 can use the compatibility reducer, but may omit complete tool or usage
metadata.

## Driver and adapter split

The provider drivers remain separate because they have distinct settings, update packages, labels,
icons, raw-event source names, and agent-directory environment variables:

| Concern                  | Pi                                | Atomic                    |
| ------------------------ | --------------------------------- | ------------------------- |
| Driver kind              | `pi`                              | `atomic`                  |
| Default binary           | `pi`                              | `atomic`                  |
| Package                  | `@earendil-works/pi-coding-agent` | `@bastani/atomic`         |
| Agent directory variable | `PI_CODING_AGENT_DIR`             | `ATOMIC_CODING_AGENT_DIR` |
| Raw event source         | `pi.rpc`                          | `atomic.rpc`              |

The lifecycle reducer is shared in
[`AtomicAdapter.ts`](../../apps/server/src/provider/Layers/AtomicAdapter.ts) through
`makePiCompatibleAdapter`. [`PiAdapter.ts`](../../apps/server/src/provider/Layers/PiAdapter.ts) and
the Atomic wrapper supply small provider definitions instead of duplicating event handling.

Provider discovery follows the same shape. The shared logic in
[`AtomicProvider.ts`](../../apps/server/src/provider/Layers/AtomicProvider.ts) checks the binary,
starts a temporary no-session RPC peer, and requests state, models, and commands. Pi-specific
version guidance stays in
[`PiProvider.ts`](../../apps/server/src/provider/Layers/PiProvider.ts).

This is intentionally a deep adapter boundary: differences that affect presentation or process
configuration stay in definitions, while ordering, session ownership, and terminal lifecycle rules
have one implementation.

## Process and framing contract

[`AtomicRpcProcess.ts`](../../apps/server/src/provider/atomic/AtomicRpcProcess.ts) owns one child
process and exposes request, notification, event-stream, and kill operations.

- The child starts as `<binary> --mode rpc`. Session processes also receive `--no-approve` unless
  launch arguments explicitly contain `--approve` or `--no-approve`.
- Requests and notifications are JSON objects framed by an ASCII LF (`\n`). JSON strings may contain
  Unicode line separator U+2028; it is data, not an RPC frame boundary.
- Standard input remains open for the lifetime of the session. Closing it after the first command
  terminates interactive RPC operation.
- Responses are correlated by generated request IDs. Unsolicited events are published separately.
- The first request has a 90-second budget because Atomic can refresh credentials and fetch model
  metadata before replying. Later requests use a 15-second budget.
- A clean output EOF fails pending requests immediately rather than making them wait for a timeout.

Each response carries an out-of-band `precedingEventSequence`. The adapter waits until all earlier
events have been mapped before it treats a response as proof that a turn is idle or settled. This
barrier prevents a synthetic success from racing ahead of a terminal event already emitted by the
CLI.

The session owns a closeable Effect scope. Ownership must move to the live session context before
`startSession` returns; otherwise the child process and event consumer are finalized and a later
turn appears to dispatch successfully while producing no output.

## RPC lifecycle mapping

The shared reducer maps Pi-compatible events into provider runtime events:

| RPC event                         | T3 runtime behavior                                         |
| --------------------------------- | ----------------------------------------------------------- |
| `agent_start`                     | Starts the provider turn                                    |
| `message_start`                   | Opens assistant and, when needed, reasoning items           |
| `message_update`                  | Streams text or thinking deltas                             |
| `message_end`                     | Reconciles authoritative content and closes message items   |
| `tool_execution_start/update/end` | Starts, updates, and completes a dynamic tool item          |
| `auto_retry_start/end`            | Shows nonfatal retry warnings                               |
| `compaction_start/end`            | Shows context compaction work                               |
| `agent_end`                       | No terminal action; a retry or queued run may follow        |
| `agent_settled`                   | Reads session statistics and completes or fails the T3 turn |

`agent_settled`, not `agent_end`, is authoritative. Atomic may compact, retry, or execute a queued
follow-up after a low-level agent run ends. Treating `agent_end` as terminal truncates that work and
can leave workflow output invisible.

Assistant-cycle errors are held until settlement. A later successful assistant message clears a
recoverable error; an error still present at `agent_settled` becomes a runtime error and failed turn.
An `extension_error` is only a warning because Pi extensions are best-effort and one incompatible
extension does not imply that the agent failed.

After settlement, `get_session_stats` is mapped to T3 context-window, input, cached-input, output,
total-token, and tool-use fields when the CLI supplies them.

## Extension UI requests

An unsolicited `extension_ui_request` is mapped to structured T3 user input:

- `select` becomes one question with the supplied choices.
- `confirm` becomes Yes and No choices.
- `input` and `editor` become free-text questions.
- Pi's `prefill` becomes the question's initial value.
- `notify` with warning or error severity becomes a runtime warning; informational terminal chrome
  is not copied into chat.

Prompt RPC calls do not use the ordinary command timeout because a person may take an arbitrary
amount of time to respond. When a turn settles, any unanswered request is resolved as abandoned so
stale prompts do not remain in the composer.

## Atomic workflow projection

Atomic emits workflow lifecycle data as `entry_appended` records and as custom message content.
The adapter normalizes both forms and deduplicates identical state transitions. Supported lifecycle
records include run and stage start/end, waiting, pause, and resume.

The projection preserves Atomic's run UUID, stage UUID, stage ordering, and parent-stage UUIDs.
Stable T3 task IDs are derived from the run and stage IDs, and dependency IDs become
`dependsOnTaskIds`. This lets the Agents panel render dependency layers instead of presenting a
workflow as an unrelated flat list. Waiting stages receive an explicit **Awaiting input** state.

Workflow source is an inspection feature, not arbitrary file access. A script link is served only
when all of these checks pass:

1. The requested path is absolute.
2. The file resolves under the current thread workspace's `.atomic/workflows` directory.
3. The resolved leaf is a regular `.js` or `.ts` file, including after symlink resolution.
4. The read stays within the size cap and the file does not change during inspection.

Claude's existing contained `.js` workflow source behavior remains unchanged. Atomic source is
displayed in the existing Agents-panel script viewer through the same orchestration query.

## Configuration and continuation

Each provider instance supports:

- an explicit binary path for CLIs outside the server process's `PATH`;
- an optional isolated agent directory;
- additional tokenized launch arguments; and
- multiple independently configured provider instances.

Models use the CLI's `provider/model` identity. Thinking choices come from the model's reported
capabilities. Model changes do not require a new T3 thread, but continuation identity remains scoped
to the configured provider instance.

Pi and Atomic currently support agent sessions only. They do not implement T3's auxiliary commit
message, pull-request text, branch-name, or thread-title generation operations.

## Known boundary

The parent Atomic RPC process exposes workflow lifecycle and summary records, but it does not expose
private child-stage reasoning/tool streams or a complete stage-chat and human-in-the-loop response
transport. T3 therefore shows honest stage status, dependencies, summaries, and source without
inventing child transcripts.

Attached stage transcripts, stage steering and follow-ups, first-class run controls, and complete
workflow human-in-the-loop answers require a narrow Atomic workflow-store/SDK bridge or a new
upstream JSON-safe RPC API. That bridge should preserve the current provider runtime contract rather
than coupling the web client directly to Atomic storage.

## Focused verification

Changes to this adapter should exercise the smallest relevant suites:

- RPC framing, startup budget, response correlation, EOF, and event ordering in
  `AtomicRpcProcess.test.ts`;
- shared chat, thinking, tools, settlement, prompts, retries, errors, usage, and workflow projection
  in `AtomicAdapter.test.ts`;
- Pi provider definitions and compatibility in `PiAdapter.test.ts` and `PiProvider.test.ts`;
- driver registration, contracts, workflow-source containment, pending input, and subagent runtime
  projection in their adjacent focused tests.

Use a temporary or repo-local T3 home for visible acceptance. Never point a development server at a
user's normal T3 data directory.
