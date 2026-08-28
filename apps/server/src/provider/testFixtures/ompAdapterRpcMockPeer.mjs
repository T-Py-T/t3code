let buffer = "";
let negotiated = false;
let streaming = false;
let todoPhases = [];
let pendingApproval;
let sessionNamed = false;
let currentSessionPath = "/tmp/omp-parent-session.jsonl";
let switchedSession = false;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(command, data) {
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

function reject(command, error) {
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error,
  });
}

function state() {
  return {
    model: {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      name: "GPT-5.6 Sol",
      reasoning: true,
    },
    thinkingLevel: "high",
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    interruptMode: "immediate",
    sessionFile: currentSessionPath,
    sessionId: "omp-adapter-session",
    autoCompactionEnabled: true,
    fastModeEnabled: false,
    fastModeActive: false,
    tokensPerSecond: null,
    messageCount: 0,
    queuedMessageCount: 0,
    todoPhases,
  };
}

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function emitAssistant(text) {
  const message = assistantMessage(text);
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  write({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  write({ type: "message_end", message });
}

function runDetachedSubagentTurn(command) {
  streaming = true;
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  write({ type: "agent_start" });
  write({ type: "auto_compaction_start", reason: "threshold" });
  write({ type: "auto_compaction_end", success: true });
  emitAssistant("PARENT_DISPATCH");
  write({
    type: "subagent_lifecycle",
    payload: {
      id: "omp-child-1",
      agent: "researcher",
      agentSource: "project",
      description: "Inspect the OMP lifecycle",
      status: "started",
      sessionFile: "/tmp/omp-child-1/session.jsonl",
      parentToolCallId: "task-tool-1",
      index: 0,
      detached: true,
    },
  });
  todoPhases = [
    {
      name: "Build",
      tasks: [
        { content: "Project the detached child", status: "in_progress" },
        { content: "Verify parent settlement", status: "pending" },
      ],
    },
  ];
  write({
    type: "tool_execution_end",
    toolCallId: "todo-tool-1",
    toolName: "todo",
    args: { op: "init" },
    result: { details: { phases: todoPhases } },
    isError: false,
  });
  write({
    type: "tool_execution_end",
    toolCallId: "write-workflow-1",
    toolName: "write",
    args: {
      path: ".omp/commands/detached-validation.md",
      content: "# Detached validation\n\n1. Project child status\n2. Resume parent\n",
    },
    result: { content: [{ type: "text", text: "Wrote detached-validation.md" }] },
    isError: false,
  });
  write({
    type: "subagent_progress",
    payload: {
      index: 0,
      agent: "researcher",
      agentSource: "project",
      task: "Inspect the OMP lifecycle",
      parentToolCallId: "task-tool-1",
      sessionFile: "/tmp/omp-child-1/session.jsonl",
      detached: true,
      progress: {
        index: 0,
        id: "omp-child-1",
        agent: "researcher",
        agentSource: "project",
        status: "running",
        task: "Inspect the OMP lifecycle",
        currentTool: "read",
        recentTools: [],
        recentOutput: ["Reading the RPC implementation"],
        toolCount: 1,
        requests: 1,
        tokens: 123,
        contextTokens: 100,
        contextWindow: 200000,
        cost: 0.01,
        durationMs: 25,
        resolvedModel: "openai-codex/gpt-5.6-sol:high",
      },
    },
  });
  write({ type: "agent_end", isTerminal: true, messages: [assistantMessage("PARENT_DISPATCH")] });

  setTimeout(() => {
    write({
      type: "subagent_event",
      payload: {
        id: "omp-child-1",
        event: {
          type: "message_end",
          message: assistantMessage("CHILD_TRANSCRIPT_VISIBLE"),
        },
      },
    });
    write({
      type: "subagent_lifecycle",
      payload: {
        id: "omp-child-1",
        agent: "researcher",
        agentSource: "project",
        description: "Inspect the OMP lifecycle",
        status: "completed",
        sessionFile: "/tmp/omp-child-1/session.jsonl",
        parentToolCallId: "task-tool-1",
        index: 0,
        detached: true,
      },
    });
    setTimeout(() => {
      write({ type: "agent_start" });
      emitAssistant("PARENT_RESUMED_AFTER_CHILD");
      todoPhases = [
        {
          name: "Build",
          tasks: [
            { content: "Project the detached child", status: "completed" },
            { content: "Verify parent settlement", status: "completed" },
          ],
        },
      ];
      write({
        type: "tool_execution_end",
        toolCallId: "todo-tool-2",
        toolName: "todo",
        args: { op: "done" },
        result: { details: { phases: todoPhases } },
        isError: false,
      });
      streaming = false;
      write({
        type: "agent_end",
        isTerminal: true,
        messages: [assistantMessage("PARENT_RESUMED_AFTER_CHILD")],
      });
    }, 10);
  }, 25);
}

function runLocalCommand(command) {
  respond(command, { agentInvoked: false });
  write({ type: "command_output", text: "OMP_COMPUTER_STATUS_OK" });
  write({ type: "prompt_result", id: command.id, agentInvoked: false });
}

function runApprovalTurn(command) {
  streaming = true;
  pendingApproval = command;
  write({ type: "agent_start" });
  write({
    type: "extension_ui_request",
    id: "omp-approval-1",
    method: "confirm",
    title: "OMP approval",
    message: "Continue the OMP action?",
  });
}

function runSteerStart(command) {
  streaming = true;
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  write({ type: "agent_start" });
  emitAssistant("OMP_STEER_WAITING");
}

function runSteerFinish(command) {
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  emitAssistant("OMP_STEERED_OK");
  streaming = false;
  write({ type: "agent_end", isTerminal: true, messages: [assistantMessage("OMP_STEERED_OK")] });
}

function runFollowUpFinish(command) {
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  emitAssistant("OMP_FOLLOW_UP_OK");
  streaming = false;
  write({ type: "agent_end", isTerminal: true, messages: [assistantMessage("OMP_FOLLOW_UP_OK")] });
}

function runInterruptTurn(command) {
  streaming = true;
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  write({ type: "agent_start" });
  emitAssistant("OMP_INTERRUPT_WAITING");
}

function runInterruptWorkflowTurn(command) {
  streaming = true;
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  write({ type: "agent_start" });
  todoPhases = [
    {
      name: "Interrupt",
      tasks: [{ content: "Stop projected work", status: "in_progress" }],
    },
  ];
  write({
    type: "tool_execution_end",
    toolCallId: "todo-interrupt-start",
    toolName: "todo",
    args: { op: "init" },
    result: { details: { phases: todoPhases } },
    isError: false,
  });
  write({
    type: "subagent_lifecycle",
    payload: {
      id: "omp-interrupt-child",
      agent: "researcher",
      status: "started",
      description: "Child awaiting interrupt",
    },
  });
}

function runCompletedTodoPlan(command, label) {
  streaming = true;
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  write({ type: "agent_start" });
  todoPhases = [
    {
      name: label,
      tasks: [{ content: `${label} task`, status: "in_progress" }],
    },
  ];
  write({
    type: "tool_execution_end",
    toolCallId: `todo-${label}-start`,
    toolName: "todo",
    args: { op: "init" },
    result: { details: { phases: todoPhases } },
    isError: false,
  });
  todoPhases = [
    {
      name: label,
      tasks: [{ content: `${label} task`, status: "completed" }],
    },
  ];
  write({
    type: "tool_execution_end",
    toolCallId: `todo-${label}-done`,
    toolName: "todo",
    args: { op: "done" },
    result: { details: { phases: todoPhases } },
    isError: false,
  });
  streaming = false;
  write({ type: "agent_end", isTerminal: true, messages: [] });
}

function runRemovedTodoPlan(command) {
  streaming = true;
  respond(command, { agentInvoked: true });
  write({ type: "prompt_result", id: command.id, agentInvoked: true });
  write({ type: "agent_start" });
  todoPhases = [
    {
      name: "Mutable plan",
      tasks: [{ content: "Remove this task", status: "in_progress" }],
    },
  ];
  write({
    type: "tool_execution_end",
    toolCallId: "todo-remove-start",
    toolName: "todo",
    args: { op: "init" },
    result: { details: { phases: todoPhases } },
    isError: false,
  });
  setTimeout(() => {
    todoPhases = [];
    write({
      type: "tool_execution_end",
      toolCallId: "todo-remove-finish",
      toolName: "todo",
      args: { op: "rm" },
      result: { details: { phases: todoPhases } },
      isError: false,
    });
    streaming = false;
    write({ type: "agent_end", isTerminal: true, messages: [] });
  }, 20);
}

function onCommand(command) {
  if (command.type === "negotiate_protocol") {
    negotiated = true;
    respond(command, { protocolVersion: 2 });
    return;
  }
  if (!negotiated) process.exit(43);
  switch (command.type) {
    case "set_subagent_subscription":
      respond(command, { level: command.level });
      return;
    case "get_subagents":
      if (process.env.OMP_FAIL_SUBAGENTS === "1") {
        reject(command, "subagent snapshot unavailable");
        return;
      }
      respond(command, {
        subagents:
          process.env.OMP_EXPECT_RESUME_PATH && switchedSession
            ? [
                {
                  id: "omp-resumed-child",
                  agent: "researcher",
                  description: "Continue the resumed investigation",
                  status: "running",
                  sessionFile: "/tmp/omp-resumed-child/session.jsonl",
                  progress: {
                    id: "omp-resumed-child",
                    status: "running",
                    resolvedModel: "openai-codex/gpt-5.6-sol:high",
                  },
                },
              ]
            : [],
      });
      return;
    case "get_state":
      if (process.env.OMP_EXPECT_SESSION_TITLE && !sessionNamed) process.exit(45);
      respond(command, state());
      return;
    case "set_session_name":
      if (process.env.OMP_EXPECT_SESSION_TITLE !== command.name) process.exit(46);
      if (process.env.OMP_EXPECT_RESUME_PATH && !switchedSession) process.exit(47);
      sessionNamed = true;
      respond(command);
      return;
    case "switch_session":
      if (process.env.OMP_EXPECT_RESUME_PATH !== command.sessionPath) process.exit(48);
      switchedSession = true;
      currentSessionPath = command.sessionPath;
      respond(command, { cancelled: false });
      return;
    case "get_session_stats":
      respond(command, {
        tokens: { input: 100, output: 50, cacheRead: 25, total: 175 },
        contextUsage: { tokens: 150, contextWindow: 200000 },
        toolCalls: 1,
      });
      return;
    case "prompt":
      if (command.message === "/computer status") runLocalCommand(command);
      else if (command.message === "/approval-test") runApprovalTurn(command);
      else if (command.message === "/steer-test") runSteerStart(command);
      else if (command.message === "/interrupt-test") runInterruptTurn(command);
      else if (command.message === "/interrupt-workflow-test") runInterruptWorkflowTurn(command);
      else if (command.message === "/first-plan") runCompletedTodoPlan(command, "First plan");
      else if (command.message === "/second-plan") runCompletedTodoPlan(command, "Second plan");
      else if (command.message === "/removed-plan") runRemovedTodoPlan(command);
      else if (command.streamingBehavior === "followUp") runFollowUpFinish(command);
      else if (command.streamingBehavior === "steer") runSteerFinish(command);
      else runDetachedSubagentTurn(command);
      return;
    case "abort":
      streaming = false;
      respond(command);
      return;
    case "extension_ui_response":
      if (pendingApproval && command.id === "omp-approval-1" && command.confirmed === true) {
        const prompt = pendingApproval;
        pendingApproval = undefined;
        respond(prompt, { agentInvoked: true });
        write({ type: "prompt_result", id: prompt.id, agentInvoked: true });
        emitAssistant("OMP_APPROVAL_ACCEPTED");
        streaming = false;
        write({
          type: "agent_end",
          isTerminal: true,
          messages: [assistantMessage("OMP_APPROVAL_ACCEPTED")],
        });
      }
      return;
    default:
      respond(command);
  }
}

write({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 262144,
  maxReassembledFrameBytes: 67108864,
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) onCommand(JSON.parse(line));
  }
});
