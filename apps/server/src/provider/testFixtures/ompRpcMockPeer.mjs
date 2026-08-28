const launchArgs = new Set(process.argv.slice(2));

if (!launchArgs.has("--mode") || !launchArgs.has("rpc")) {
  process.exit(41);
}

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 262144,
    maxReassembledFrameBytes: 67108864,
  })}\n`,
);

let buffer = "";
let negotiated = false;

function respond(command, data) {
  process.stdout.write(
    `${JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    })}\n`,
  );
}

function onCommand(command) {
  if (command.type === "negotiate_protocol") {
    if (command.protocolVersion !== 2) process.exit(42);
    negotiated = true;
    respond(command, { protocolVersion: 2 });
    return;
  }
  if (!negotiated) process.exit(43);

  switch (command.type) {
    case "get_state":
      respond(command, {
        model: {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai-codex",
          reasoning: true,
          thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
        },
        thinkingLevel: "high",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "all",
        interruptMode: "immediate",
        sessionId: "omp-provider-test",
        autoCompactionEnabled: true,
        fastModeEnabled: false,
        fastModeActive: false,
        tokensPerSecond: null,
        messageCount: 0,
        queuedMessageCount: 0,
        todoPhases: [],
      });
      return;
    case "get_available_models":
      respond(command, {
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai-codex",
            reasoning: true,
            thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
          },
        ],
      });
      return;
    case "get_available_commands":
      respond(command, {
        commands: [
          {
            name: "plan",
            description: "Create an implementation plan",
            input: { hint: "goal" },
            source: "builtin",
          },
          {
            name: "review",
            description: "Review the current branch",
            source: "skill",
          },
        ],
      });
      return;
    default:
      process.exit(44);
  }
}

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
