let buffer = "";
let isStreaming = false;
let pendingUiPrompt;
let abortableTurnActive = false;

const write = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const response = (command, data) => {
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
};

const failureResponse = (command, error) => {
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error,
  });
};

const assistantMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Check the shared Pi event stream." },
    { type: "text", text: "PI_RPC_OK" },
  ],
};

const runChatTurn = (command) => {
  isStreaming = true;
  response(command);
  write({ type: "agent_start" });
  write({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: command.message }] },
  });
  write({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: command.message }] },
  });
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  write({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Check the shared Pi event stream.",
    },
  });
  write({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "PI_RPC_OK",
    },
  });
  write({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "README.md" },
  });
  write({
    type: "tool_execution_update",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "README.md" },
    partialResult: { content: [{ type: "text", text: "partial tool output" }] },
  });
  write({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "README.md" },
    result: { content: [{ type: "text", text: "complete tool output" }] },
    isError: false,
  });
  write({ type: "message_end", message: assistantMessage });
  write({ type: "agent_end", messages: [assistantMessage] });
  setTimeout(() => {
    const followUp = {
      role: "assistant",
      content: [{ type: "text", text: "QUEUED_FOLLOW_UP" }],
    };
    write({ type: "agent_start" });
    write({ type: "message_start", message: { role: "assistant", content: [] } });
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "QUEUED_FOLLOW_UP" },
    });
    write({ type: "message_end", message: followUp });
    write({ type: "agent_end", messages: [followUp] });
    isStreaming = false;
    write({ type: "agent_settled" });
  }, 15);
};

const runWorkflowCommand = (command) => {
  const runId = "workflow-run-1";
  write({
    type: "message_start",
    message: {
      role: "custom",
      customType: "workflows:chat-surface",
      content: "Workflow classify-and-act started.",
      display: true,
      details: {
        kind: "dispatch",
        workflowName: "classify-and-act",
        runId,
        inputs: { prompt: "Return WORKFLOW_OK" },
      },
    },
  });
  write({
    type: "entry_appended",
    entry: {
      type: "custom",
      customType: "workflow.run.start",
      data: { runId, name: "classify-and-act", inputs: { prompt: "Return WORKFLOW_OK" } },
    },
  });
  write({
    type: "message_end",
    message: {
      role: "custom",
      customType: "workflow.run.start",
      display: false,
      details: { runId, name: "classify-and-act", inputs: { prompt: "Return WORKFLOW_OK" } },
    },
  });
  write({
    type: "message_end",
    message: {
      role: "custom",
      customType: "workflows:chat-surface",
      content: "Workflow classify-and-act started.",
      display: true,
      details: { kind: "dispatch", workflowName: "classify-and-act", runId },
    },
  });
  write({
    type: "message_end",
    message: {
      role: "custom",
      customType: "workflows:lifecycle-notice",
      display: false,
      details: {
        kind: "awaiting_input",
        scope: "run",
        runId,
        workflowName: "classify-and-act",
        promptMessage: "Provide workflow inputs.",
      },
    },
  });
  response(command);
  setTimeout(() => {
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.start",
        data: { runId, stageId: "classify", name: "Classify", parentIds: [] },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.start",
        data: { runId, stageId: "inspect", name: "Inspect", parentIds: [] },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.end",
        data: {
          runId,
          stageId: "classify",
          name: "Classify",
          status: "completed",
          summary: "Classification complete",
        },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.end",
        data: {
          runId,
          stageId: "inspect",
          name: "Inspect",
          parentIds: [],
          status: "completed",
          summary: "Inspection complete",
        },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.start",
        data: {
          runId,
          stageId: "synthesize",
          name: "Synthesize",
          parentIds: ["classify", "inspect"],
        },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.end",
        data: {
          runId,
          stageId: "synthesize",
          name: "Synthesize",
          parentIds: ["classify", "inspect"],
          status: "completed",
          summary: "Synthesis complete",
        },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.start",
        data: {
          runId,
          stageId: "approve",
          name: "Approve",
          parentIds: ["synthesize"],
          replayKey: "prompt:confirm:approve",
        },
      },
    });
    write({
      type: "message_end",
      message: {
        role: "custom",
        customType: "workflows:lifecycle-notice",
        content: "Workflow is awaiting approval.",
        display: true,
        details: {
          kind: "awaiting_input",
          scope: "stage",
          runId,
          workflowName: "classify-and-act",
          status: "waiting",
          stageId: "approve",
          stageName: "Approve",
          promptId: "prompt-approve-1",
          promptKind: "confirm",
          promptMessage: "Approve the synthesized result?",
        },
      },
    });
    write({
      type: "message_end",
      message: {
        role: "custom",
        customType: "workflows:lifecycle-notice",
        display: false,
        details: {
          kind: "resumed",
          scope: "stage",
          runId,
          workflowName: "classify-and-act",
          stageId: "approve",
          stageName: "Approve",
        },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.stage.end",
        data: {
          runId,
          stageId: "approve",
          name: "Approve",
          parentIds: ["synthesize"],
          status: "completed",
          summary: "Approved",
        },
      },
    });
    write({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "workflow.run.end",
        data: {
          runId,
          name: "classify-and-act",
          status: "completed",
          result: "WORKFLOW_OK",
        },
      },
    });
    write({
      type: "message_end",
      message: {
        role: "custom",
        customType: "workflow.run.end",
        display: false,
        details: {
          runId,
          name: "classify-and-act",
          status: "completed",
          result: "WORKFLOW_OK",
        },
      },
    });
  }, 20);
};

const runRecoverableExtensionErrorTurn = (command) => {
  isStreaming = true;
  response(command);
  write({ type: "agent_start" });
  write({
    type: "extension_error",
    extensionPath: "/tmp/incompatible-extension.mjs",
    error: "Optional extension uses an older Pi API.",
  });
  const failedMessage = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "Optional extension intercepted an incompatible tool result.",
  };
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  write({
    type: "message_update",
    assistantMessageEvent: { type: "error", reason: "error", error: failedMessage },
  });
  write({ type: "message_end", message: failedMessage });
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "RECOVERED_AFTER_EXTENSION_ERROR" }],
    stopReason: "stop",
  };
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  write({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "RECOVERED_AFTER_EXTENSION_ERROR",
    },
  });
  write({ type: "message_end", message });
  write({ type: "agent_end", messages: [message] });
  isStreaming = false;
  write({ type: "agent_settled" });
};

const runTerminalAssistantErrorTurn = (command) => {
  isStreaming = true;
  response(command);
  write({ type: "agent_start" });
  const failedMessage = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "The model request failed permanently.",
  };
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  write({
    type: "message_update",
    assistantMessageEvent: { type: "error", reason: "error", error: failedMessage },
  });
  write({ type: "message_end", message: failedMessage });
  write({ type: "agent_end", messages: [failedMessage] });
  isStreaming = false;
  write({ type: "agent_settled" });
};

const requestLongLivedUi = (command) => {
  isStreaming = true;
  pendingUiPrompt = command;
  write({
    type: "extension_ui_request",
    id: "ui-editor-1",
    method: "editor",
    title: "Review workflow input",
    message: "Edit this value before the workflow continues.",
    prefill: "ORIGINAL_WORKFLOW_VALUE",
  });
};

const runAbortableTurn = (command) => {
  isStreaming = true;
  abortableTurnActive = true;
  response(command);
  write({ type: "agent_start" });
  write({
    type: "tool_execution_start",
    toolCallId: "abort-tool-1",
    toolName: "read",
    args: { path: "README.md" },
  });
};

const handle = (command) => {
  switch (command.type) {
    case "get_state":
      response(command, {
        model: { provider: "openai-codex", id: "gpt-5.4" },
        thinkingLevel: "high",
        sessionId: "pi-rpc-mock-session",
        sessionFile: "/tmp/pi-rpc-mock-session.jsonl",
        isStreaming,
      });
      return;
    case "get_available_models":
      response(command, {
        models: [{ provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4", reasoning: true }],
      });
      return;
    case "get_commands":
      response(command, { commands: [] });
      return;
    case "get_session_stats":
      response(command, {
        sessionFile: "/tmp/pi-rpc-mock-session.jsonl",
        sessionId: "pi-rpc-mock-session",
        userMessages: 1,
        assistantMessages: 2,
        toolCalls: 1,
        totalMessages: 5,
        tokens: { input: 1200, output: 300, cacheRead: 400, cacheWrite: 0, total: 1900 },
        contextUsage: { tokens: 1500, contextWindow: 200000, percent: 0.75 },
      });
      return;
    case "prompt":
      if (command.message === "/t3-recoverable-extension-error") {
        runRecoverableExtensionErrorTurn(command);
      } else if (command.message === "/t3-terminal-assistant-error") {
        runTerminalAssistantErrorTurn(command);
      } else if (command.message === "/t3-prompt-rejected") {
        failureResponse(command, "The prompt transport rejected the request.");
      } else if (command.message === "/t3-abort-drain") {
        runAbortableTurn(command);
      } else if (command.message === "/t3-ui-wait") {
        requestLongLivedUi(command);
      } else if (String(command.message).startsWith("/workflow")) {
        runWorkflowCommand(command);
      } else {
        runChatTurn(command);
      }
      return;
    case "abort":
      if (abortableTurnActive) {
        write({
          type: "entry_appended",
          entry: {
            type: "custom",
            customType: "workflow.run.start",
            data: { runId: "abort-drain-workflow", name: "abort-drain-workflow" },
          },
        });
        write({
          type: "tool_execution_end",
          toolCallId: "abort-tool-1",
          toolName: "read",
          args: { path: "README.md" },
          result: { content: [{ type: "text", text: "abort tool output" }] },
          isError: false,
        });
        abortableTurnActive = false;
        isStreaming = false;
      }
      response(command);
      return;
    case "extension_ui_response":
      if (pendingUiPrompt && command.id === "ui-editor-1") {
        const prompt = pendingUiPrompt;
        pendingUiPrompt = undefined;
        response(prompt);
        isStreaming = false;
      }
      return;
    default:
      response(command);
  }
};

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
