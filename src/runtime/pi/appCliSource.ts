export const renderPiCliSource = (): string => String.raw`const cliEngineKinds = new Set(["agy", "claude", "codex", "grok", "scripted"]);
const maxCapturedOutputBytes = 1024 * 256;
const cliOutputOptions = {
  maxBuffer: 1024 * 1024 * 8,
  timeout: Number(process.env.SPAWNFILE_CLI_ENGINE_TIMEOUT_MS ?? "300000")
};

const normalizeAgentEngineKind = (config) => {
  const kind = typeof config?.engine?.kind === "string" ? config.engine.kind : "pi";
  return cliEngineKinds.has(kind) ? kind : "pi";
};

const stripAnsi = (value) =>
  value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();

const cleanCliFinalText = (value) => {
  const text = stripAnsi(value);
  const progressLine = /^(running|handling|following|consulting|reading|querying|gathering|verifying|command succeeded|spawning the verifier|i have responded|summary of actions|actions?:)/iu;
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const filtered = lines.filter((line) => !progressLine.test(line));
  return (filtered.length > 0 ? filtered : lines).join("\n").trim();
};

const pushCapped = (chunks, chunk, state) => {
  if (state.bytes >= maxCapturedOutputBytes) {
    return;
  }
  const remaining = maxCapturedOutputBytes - state.bytes;
  const next = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(next);
  state.bytes += next.length;
};

const readBounded = async (filePath) => {
  const stats = await stat(filePath);
  if (stats.size <= maxCapturedOutputBytes) {
    return readFile(filePath, "utf8");
  }
  const content = await readFile(filePath);
  const head = content.subarray(0, maxCapturedOutputBytes).toString("utf8");
  return head + "\n[truncated " + (stats.size - maxCapturedOutputBytes) + " bytes]";
};

const copyDirectoryIfExists = async (sourcePath, targetPath) => {
  try {
    await stat(sourcePath);
  } catch {
    return;
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, {
    force: true,
    recursive: true
  });
};

const createEngineEnv = (paths, engineHomePath, extraEnv = {}) => ({
  ...process.env,
  CODEX_HOME: path.join(engineHomePath, ".codex"),
  HOME: engineHomePath,
  XDG_CACHE_HOME: path.join(engineHomePath, ".cache"),
  XDG_CONFIG_HOME: path.join(engineHomePath, ".config"),
  XDG_DATA_HOME: path.join(engineHomePath, ".local", "share"),
  ...extraEnv
});

const grokHomePreparations = new Map();

const prepareSharedGrokHome = async (paths) => {
  const sharedHomePath = path.join(path.dirname(path.dirname(paths.runtimeHomePath)), "grok-home");
  const grokHomePath = path.join(sharedHomePath, ".grok");
  const markerPath = path.join(sharedHomePath, ".spawnfile-grok-home-ready");
  await mkdir(sharedHomePath, { recursive: true });
  try {
    await stat(markerPath);
  } catch {
    await copyDirectoryIfExists(path.join(paths.homePath, ".grok"), grokHomePath);
    await mkdir(grokHomePath, { recursive: true });
    await writeFile(markerPath, "ready\n");
  }
  return { grokHomePath, sharedHomePath };
};

const getSharedGrokHome = (paths) => {
  const sharedHomePath = path.join(path.dirname(path.dirname(paths.runtimeHomePath)), "grok-home");
  let preparation = grokHomePreparations.get(sharedHomePath);
  if (!preparation) {
    preparation = prepareSharedGrokHome(paths).catch((error) => {
      grokHomePreparations.delete(sharedHomePath);
      throw error;
    });
    grokHomePreparations.set(sharedHomePath, preparation);
  }
  return preparation;
};

const spawnWithInput = (command, args, input, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error(command + " timed out after " + cliOutputOptions.timeout + "ms"));
  }, cliOutputOptions.timeout);
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  child.stdout.on("data", (chunk) => pushCapped(stdout, chunk, stdoutState));
  child.stderr.on("data", (chunk) => pushCapped(stderr, chunk, stderrState));
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    const output = {
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8")
    };
    if (code === 0) {
      resolve(output);
      return;
    }
    reject(new Error(command + " exited " + (code ?? signal) + ": " + (output.stderr || output.stdout)));
  });
  child.stdin.end(input);
});

const spawnToFiles = (command, args, options) => new Promise((resolve, reject) => {
  const stdoutFd = openSync(options.stdoutPath, "w");
  const stderrFd = openSync(options.stderrPath, "w");
  const closeFiles = () => {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  };
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", stdoutFd, stderrFd]
  });
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    closeFiles();
    reject(new Error(command + " timed out after " + cliOutputOptions.timeout + "ms; stderr=" + options.stderrPath));
  }, cliOutputOptions.timeout);
  child.on("error", (error) => {
    clearTimeout(timer);
    closeFiles();
    reject(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    closeFiles();
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(command + " exited " + (code ?? signal) + "; stderr=" + options.stderrPath + "; stdout=" + options.stdoutPath));
  });
});

const formatCliWakePrompt = (event) => [
  "Wake event:",
  "- id: " + event.id,
  "- kind: " + event.kind,
  "- from: " + (event.from ?? "operator"),
  "",
  event.text
].join("\n");

const buildCliMemoryRequest = (event) => {
  const context = readMemoryContext({ kind: event.kind, id: event.id, from: event.from, text: event.text, context: event.context });
  return {
    context,
    request: {
      eventId: event.id,
      kind: event.kind,
      text: event.text,
      from: event.from,
      context
    }
  };
};

const createCliEnginePrompt = (config, paths, event, memoryPromptText) => [
  createAgentInstructions(config, paths.workspacePath),
  "",
  memoryPromptText ?? formatCliWakePrompt(event),
  "",
  "Use the workspace and Moltnet skill/CLI according to your instructions.",
  "Use recalled Daimon memory as authoritative context when it is relevant.",
  "The Daimon runtime publishes your final CLI output as your reply to the wake source.",
  "Return only the exact message body that should be published. Do not include summaries, markdown headings, tool reports, or action logs.",
  "Do not return progress reports such as 'handling', 'reading', 'querying', 'I will', or 'I have responded'. If your instructions require a tool or Moltnet action, execute it before the final reply.",
  "If your instructions include an exact shell command, run that command before answering.",
  "Use moltnet send only when you need to coordinate with a different room or agent before your final reply; do not use it for the final reply itself.",
  "If no response is needed, return one short sentence explaining why."
].join("\n");

const formatTurnError = (error) =>
  error instanceof Error ? error.message : String(error);

const recordCliMemoryTurn = async (memory, prepared, request, result, outputText, error) => {
  if (!memory || !prepared) {
    return;
  }

  await memory.recordTurn({
    error,
    outputText,
    principal: prepared.principal,
    prompt: prepared.packet,
    recall: prepared.recall,
    request,
    result
  });
};

class CliEngineAgentHandle {
  constructor(config, paths) {
    this.config = config;
    this.paths = paths;
    this.engine = normalizeAgentEngineKind(config);
    this.memory = config.memory ? createMemoryRuntime(createMemoryRuntimeOptions(config)) : null;
  }

  async wake(event) {
    const startedAt = new Date();
    const { request } = buildCliMemoryRequest(event);
    let engineMs;
    let memoryPrepareMs;
    let memoryPrepareStatus;
    let memoryRecordMs;
    let outputText = "";
    let prepared;
    let prompt = createCliEnginePrompt(this.config, this.paths, event);

    try {
      if (this.memory) {
        const memoryStartedAt = Date.now();
        try {
          prepared = await this.memory.prepareTurn(request);
        } catch (error) {
          memoryPrepareMs = Date.now() - memoryStartedAt;
          memoryPrepareStatus = "failed";
          throw error;
        }
        memoryPrepareMs = Date.now() - memoryStartedAt;
        memoryPrepareStatus = "completed";
        prompt = createCliEnginePrompt(this.config, this.paths, event, prepared.promptText);
      }

      // prompt is final here; stamp turn.input.submitted before the CLI engine
      // sees it, chained to the real WakeEvent id (event.id) — matching
      // daimon's own PiAgentHandle.wake() placement/shape (turnCausal.ts).
      const turnInputSubmitted = await stampTurnInputSubmitted({
        agentId: normalizeMemoryAgentId(this.config.id),
        event,
        prepared,
        promptText: prompt,
        runtimeHomePath: this.paths.runtimeHomePath
      });

      const result = await runCliEngine(this.engine, prompt, this.paths, this.config);
      engineMs = result.durationMs;
      outputText = typeof result.text === "string" ? result.text : "";

      // Success path only; chained to turnInputSubmitted above, per
      // turnCausal.ts's stampTurnOutputCompleted contract.
      await stampTurnOutputCompleted({
        agentId: normalizeMemoryAgentId(this.config.id),
        causeEventId: turnInputSubmitted.event_id,
        outputText,
        runtimeHomePath: this.paths.runtimeHomePath,
        turnId: event.id
      });

      const memoryRecordStartedAt = Date.now();
      await recordCliMemoryTurn(
        this.memory,
        prepared,
        request,
        "completed",
        outputText,
        undefined
      );
      memoryRecordMs = this.memory && prepared ? Date.now() - memoryRecordStartedAt : undefined;
      await writeTurnTrace(this.paths, createGeneratedTurnTrace({
        config: this.config,
        engine: this.engine,
        engineMs,
        event,
        memoryPrepareMs,
        memoryPrepareStatus,
        memoryRecall: prepared ? {
          redaction_count: prepared.recall.redactionCount,
          selected_count: prepared.recall.selectedEventIds.length,
          token_budget_used: prepared.recall.tokenBudgetUsed,
          total_candidates: prepared.recall.totalCandidates
        } : undefined,
        memoryRecordMs,
        outputText,
        prompt,
        startedAt,
        status: "completed"
      }));
      return result;
    } catch (error) {
      if (this.memory && memoryPrepareStatus === undefined) {
        memoryPrepareStatus = "failed";
      }
      await recordCliMemoryTurn(
        this.memory,
        prepared,
        request,
        "failed",
        "",
        formatTurnError(error)
      );
      await writeTurnTrace(this.paths, createGeneratedTurnTrace({
        config: this.config,
        engine: this.engine,
        engineMs,
        error: formatTurnError(error),
        errorStage: memoryPrepareStatus === "failed" && !prepared ? "memory_prepare" : "engine_prompt",
        event,
        memoryPrepareMs,
        memoryPrepareStatus,
        memoryRecall: prepared ? {
          redaction_count: prepared.recall.redactionCount,
          selected_count: prepared.recall.selectedEventIds.length,
          token_budget_used: prepared.recall.tokenBudgetUsed,
          total_candidates: prepared.recall.totalCandidates
        } : undefined,
        memoryRecordMs,
        outputText,
        prompt,
        startedAt,
        status: "failed"
      }));
      throw error;
    }
  }

  stop() {}
}
`;
