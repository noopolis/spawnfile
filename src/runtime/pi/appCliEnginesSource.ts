export const renderPiCliEnginesSource = (): string => String.raw`const runCodexEngine = async (prompt, paths) => {
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

const runClaudeEngine = async (prompt, paths) => {
  const engineHomePath = path.join(paths.runtimeHomePath, "claude-home");
  await mkdir(path.join(engineHomePath, ".claude"), { recursive: true });
  await copyDirectoryIfExists(path.join(paths.homePath, ".claude"), path.join(engineHomePath, ".claude"));
  await copyDirectoryIfExists(path.join(paths.homePath, ".claude.json"), path.join(engineHomePath, ".claude.json"));
  const env = process.env.DAIMON_CLAUDE_USE_HOST_HOME === "1"
    ? process.env
    : createEngineEnv(paths, engineHomePath);
  const output = await spawnWithInput("claude", [
    "--print",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--permission-mode",
    process.env.DAIMON_CLAUDE_PERMISSION_MODE ?? "bypassPermissions",
    "--model",
    process.env.DAIMON_CLAUDE_MODEL ?? "sonnet",
    "--add-dir",
    paths.workspacePath
  ], prompt, {
    cwd: paths.workspacePath,
    env
  });
  return cleanCliFinalText(output.stdout);
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
    process.env.DAIMON_GROK_MAX_TURNS ?? "24",
    "--no-memory",
    "--disable-web-search",
    "--model",
    process.env.DAIMON_GROK_MODEL ?? "grok-composer-2.5-fast",
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

const runScriptedEngine = async (config, prompt, paths) => {
  if (typeof config?.engine_command !== "string" || config.engine_command.length === 0) {
    throw new Error("Scripted Pi engine is missing its staged engine_command path");
  }
  const scriptPath = path.join(paths.workspacePath, config.engine_command);
  await mkdir(paths.runtimeHomePath, { recursive: true });
  const promptPath = path.join(paths.runtimeHomePath, "scripted-prompt-" + Date.now() + ".txt");
  await writeFile(promptPath, prompt);
  const args = ["--prompt-file", promptPath, "--cwd", paths.workspacePath];
  let output;
  try {
    output = await execFileAsync("node", [scriptPath, ...args], {
      ...cliOutputOptions,
      cwd: paths.workspacePath,
      env: process.env
    });
  } finally {
    await unlink(promptPath).catch(() => undefined);
  }
  appendFileSync(
    path.join(paths.runtimeHomePath, "scripted-engine-calls.jsonl"),
    JSON.stringify({
      args,
      script: scriptPath,
      timestamp: new Date().toISOString()
    }) + "\n"
  );
  return output.stdout.trim();
};

const runCliEngine = async (engine, prompt, paths, config) => {
  const startedAt = Date.now();
  let text;
  if (engine === "codex") {
    text = await runCodexEngine(prompt, paths);
  } else if (engine === "claude") {
    text = await runClaudeEngine(prompt, paths);
  } else if (engine === "grok") {
    text = await runGrokEngine(prompt, paths);
  } else if (engine === "scripted") {
    text = await runScriptedEngine(config, prompt, paths);
  } else {
    text = await runAgyEngine(prompt, paths);
  }
  return {
    durationMs: Date.now() - startedAt,
    text
  };
};
`;
