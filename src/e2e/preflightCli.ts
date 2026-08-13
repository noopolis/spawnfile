import { Command } from "commander";

import { exitCodeForE2EPreflight, renderE2EPreflightText, runE2EPreflight } from "./preflight.js";

export const runPreflightCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e preflight")
    .description("Report local E2E readiness without running live runtime conversations")
    .option("--antigravity-cli-from <path>", "Antigravity CLI command override")
    .option("--antigravity-from <directory>", "Antigravity home directory override")
    .option("--claude-from <directory>", "Claude Code config directory override")
    .option("--codex-from <directory>", "Codex config directory override")
    .option("--docker-command <command>", "Docker command", "docker")
    .option("--fixture <path>", "Compile-only mixed-runtime fixture override")
    .option("--grok-from <directory>", "Grok config directory override")
    .option("--json", "Emit machine-readable JSON")
    .option("--ollama-base-url <url>", "Ollama base URL", "http://127.0.0.1:11434")
    .option("--ollama-model <name>", "Ollama embedding model to require")
    .option("--timeout-ms <ms>", "Per-check timeout", Number);

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    antigravityCliFrom?: string;
    antigravityFrom?: string;
    claudeFrom?: string;
    codexFrom?: string;
    dockerCommand?: string;
    fixture?: string;
    grokFrom?: string;
    json?: boolean;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    timeoutMs?: number;
  }>();

  const report = await runE2EPreflight({
    antigravityCliCommand: options.antigravityCliFrom,
    antigravityHome: options.antigravityFrom,
    claudeCodeDirectory: options.claudeFrom,
    codexDirectory: options.codexFrom,
    dockerCommand: options.dockerCommand,
    fixtureDirectory: options.fixture,
    grokHome: options.grokFrom,
    ollamaBaseUrl: options.ollamaBaseUrl,
    ollamaModel: options.ollamaModel,
    timeoutMs: options.timeoutMs
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderE2EPreflightText(report));
  }
  process.exitCode = exitCodeForE2EPreflight(report);
};
