export const renderPiCliSource = (): string => String.raw`const cliEngineKinds = new Set(["agy", "codex", "grok"]);
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

const createCliEnginePrompt = (config, paths, event) => [
  createIdentityPrompt(config, paths.workspacePath),
  "",
  "## Wake Event",
  "Wake id: " + event.id,
  "Wake kind: " + event.kind,
  "From: " + event.from,
  "",
  event.text,
  "",
  "Use the workspace and Moltnet skill/CLI according to your instructions.",
  "The Daimon runtime publishes your final CLI output as your reply to the wake source.",
  "Return only the exact message body that should be published. Do not include summaries, markdown headings, tool reports, or action logs.",
  "Do not return progress reports such as 'handling', 'reading', 'querying', 'I will', or 'I have responded'. If your instructions require a tool or Moltnet action, execute it before the final reply.",
  "If your instructions include an exact shell command, run that command before answering.",
  "Use moltnet send only when you need to coordinate with a different room or agent before your final reply; do not use it for the final reply itself.",
  "If no response is needed, return one short sentence explaining why."
].join("\n");

const runCodexEngine = async (prompt, paths) => {
  const engineHomePath = path.join(paths.runtimeHomePath, "codex-home");
  await mkdir(path.join(engineHomePath, ".codex"), { recursive: true });
  try {
    const authSource = path.join(paths.homePath, ".codex", "auth.json");
    const authTarget = path.join(engineHomePath, ".codex", "auth.json");
    await writeFile(authTarget, await readFile(authSource, "utf8"));
  } catch {}
  const outputPath = path.join(paths.runtimeHomePath, "codex-" + Date.now() + ".txt");
  const args = [
    "exec",
    "--sandbox",
    process.env.SPAWNFILE_CODEX_SANDBOX ?? "danger-full-access",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--color",
    "never",
    "-C",
    paths.workspacePath,
    "--output-last-message",
    outputPath,
    "-m",
    process.env.DAIMON_CODEX_MODEL ?? "gpt-5.4-mini",
    "-"
  ];
  const { stderr, stdout } = await spawnWithInput("codex", args, prompt, {
    cwd: paths.workspacePath,
    env: createEngineEnv(paths, engineHomePath)
  });
  try {
    return stripAnsi(await readFile(outputPath, "utf8"));
  } catch {
    return stripAnsi([stdout, stderr].filter(Boolean).join("\n"));
  }
};

const runGrokEngine = async (prompt, paths) => {
  const engineHomePath = path.join(paths.runtimeHomePath, "grok-home");
  await mkdir(engineHomePath, { recursive: true });
  const sharedGrok = await getSharedGrokHome(paths);
  const promptPath = path.join(paths.runtimeHomePath, "grok-prompt-" + Date.now() + ".txt");
  await writeFile(promptPath, prompt);
  const output = await execFileAsync("grok", [
    "--prompt-file",
    promptPath,
    "--max-turns",
    process.env.DAIMON_GROK_MAX_TURNS ?? "8",
    "--no-memory",
    "--disable-web-search",
    "--cwd",
    paths.workspacePath,
    "--output-format",
    "plain",
    "--always-approve",
    "--permission-mode",
    process.env.DAIMON_GROK_PERMISSION_MODE ?? "auto",
    "--allow",
    "Bash"
  ], {
    ...cliOutputOptions,
    cwd: paths.workspacePath,
    env: createEngineEnv(paths, engineHomePath, {
      GROK_HOME: sharedGrok.grokHomePath
    })
  });
  await unlink(promptPath).catch(() => undefined);
  return cleanCliFinalText(output.stdout);
};

const runAgyEngine = async (prompt, paths) => {
  const engineHomePath = path.join(paths.runtimeHomePath, "agy-home");
  await mkdir(engineHomePath, { recursive: true });
  await copyDirectoryIfExists(
    path.join(paths.homePath, ".config", "Antigravity"),
    path.join(engineHomePath, ".config", "Antigravity")
  );
  await copyDirectoryIfExists(
    path.join(paths.homePath, ".gemini", "antigravity-cli"),
    path.join(engineHomePath, ".gemini", "antigravity-cli")
  );
  const outputPath = path.join(paths.runtimeHomePath, "agy-output-" + Date.now() + ".txt");
  const errorPath = path.join(paths.runtimeHomePath, "agy-error-" + Date.now() + ".txt");
  await spawnToFiles("agy", [
    "--print",
    prompt,
    "--print-timeout",
    process.env.DAIMON_AGY_TIMEOUT ?? "300s",
    "--model",
    process.env.DAIMON_AGY_MODEL ?? "Gemini 3.5 Flash (Low)",
    "--new-project",
    "--add-dir",
    paths.workspacePath,
    "--dangerously-skip-permissions"
  ], {
    cwd: paths.workspacePath,
    env: createEngineEnv(paths, engineHomePath),
    stderrPath: errorPath,
    stdoutPath: outputPath
  });
  const text = cleanCliFinalText(await readBounded(outputPath));
  await Promise.all([unlink(outputPath), unlink(errorPath)].map((promise) => promise.catch(() => undefined)));
  return text;
};

const runCliEngine = async (engine, prompt, paths) => {
  const startedAt = Date.now();
  let text;
  if (engine === "codex") {
    text = await runCodexEngine(prompt, paths);
  } else if (engine === "grok") {
    text = await runGrokEngine(prompt, paths);
  } else {
    text = await runAgyEngine(prompt, paths);
  }
  return {
    durationMs: Date.now() - startedAt,
    text
  };
};

class CliEngineAgentHandle {
  constructor(config, paths) {
    this.config = config;
    this.paths = paths;
    this.engine = normalizeAgentEngineKind(config);
  }

  async wake(event) {
    const prompt = createCliEnginePrompt(this.config, this.paths, event);
    return runCliEngine(this.engine, prompt, this.paths);
  }

  stop() {}
}
`;
