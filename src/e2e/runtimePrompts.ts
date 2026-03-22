import { spawn } from "node:child_process";

import { SpawnfileError } from "../shared/index.js";

import type { E2ERuntime } from "./types.js";

interface CommandResult {
  stderr: string;
  stdout: string;
}

interface RuntimePromptOptions {
  agentName?: string;
  command?: string;
  configPath?: string;
  containerName: string;
  homePath?: string;
  prompt: string;
  timeoutMs?: number;
}

const wait = async (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const runCommand = async (
  command: string,
  args: string[],
  timeoutMs = 180_000
): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new SpawnfileError(
          "runtime_error",
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`
        )
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(String(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(String(chunk));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new SpawnfileError(
          "runtime_error",
          `Unable to start command ${command}: ${error.message}`
        )
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          stderr: stderr.join(""),
          stdout: stdout.join("")
        });
        return;
      }

      reject(
        new SpawnfileError(
          "runtime_error",
          signal
            ? `Command exited from signal ${signal}: ${command} ${args.join(" ")}`
            : `Command failed with exit code ${code ?? "unknown"}: ${command} ${args.join(" ")}\n${stderr.join("")}`.trim()
        )
      );
    });
  });

const fetchText = async (url: string): Promise<{ body: string; status: number }> => {
  const response = await fetch(url);
  return {
    body: await response.text(),
    status: response.status
  };
};

const getHealthUrl = (runtime: E2ERuntime): string =>
  runtime === "openclaw"
    ? "http://127.0.0.1:18789/healthz"
    : runtime === "picoclaw"
      ? "http://127.0.0.1:18790/health"
      : "http://127.0.0.1:3777/api/agents";

export const waitForRuntimeReady = async (
  runtime: E2ERuntime,
  timeoutMs = 120_000
): Promise<void> => {
  const startedAt = Date.now();
  const url = getHealthUrl(runtime);

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore readiness races and keep polling.
    }

    await wait(2_000);
  }

  throw new SpawnfileError(
    "runtime_error",
    `Runtime ${runtime} did not become ready within ${timeoutMs}ms (${url})`
  );
};

const promptOpenClaw = async (options: RuntimePromptOptions): Promise<string> => {
  const result = await runCommand(
    options.command ?? "docker",
    [
      "exec",
      "-u",
      "0",
      ...(options.homePath ? ["-e", `OPENCLAW_HOME=${options.homePath}`] : []),
      ...(options.configPath ? ["-e", `OPENCLAW_CONFIG_PATH=${options.configPath}`] : []),
      options.containerName,
      "openclaw",
      "agent",
      "--local",
      "--agent",
      "main",
      "--message",
      options.prompt,
      "--json"
    ],
    options.timeoutMs
  );
  return `${result.stdout}\n${result.stderr}`;
};

const promptPicoClaw = async (options: RuntimePromptOptions): Promise<string> => {
  const result = await runCommand(
    options.command ?? "docker",
    [
      "exec",
      ...(options.homePath ? ["-e", `HOME=${options.homePath}`, "-e", `PICOCLAW_HOME=${options.homePath}`] : []),
      ...(options.configPath ? ["-e", `PICOCLAW_CONFIG=${options.configPath}`] : []),
      options.containerName,
      "picoclaw",
      "agent",
      "-m",
      options.prompt
    ],
    options.timeoutMs
  );
  return `${result.stdout}\n${result.stderr}`;
};

const promptTinyClaw = async (options: RuntimePromptOptions): Promise<string> => {
  const enqueueResponse = await fetch("http://127.0.0.1:3777/api/message", {
    body: JSON.stringify({
      ...(options.agentName ? { agent: options.agentName } : {}),
      channel: "spawnfile-e2e",
      message: options.prompt,
      sender: "spawnfile-e2e"
    }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  if (!enqueueResponse.ok) {
    throw new SpawnfileError(
      "runtime_error",
      `TinyClaw enqueue failed with status ${enqueueResponse.status}`
    );
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 180_000;

  while (Date.now() - startedAt <= timeoutMs) {
    const { body, status } = await fetchText("http://127.0.0.1:3777/api/responses?limit=20");
    if (status === 200 && body.includes(options.prompt.replace("Reply with exactly ", "").replace(" and nothing else.", ""))) {
      return body;
    }
    await wait(2_000);
  }

  throw new SpawnfileError(
    "runtime_error",
    `TinyClaw did not return a response within ${timeoutMs}ms`
  );
};

export const promptRuntime = async (
  runtime: E2ERuntime,
  options: RuntimePromptOptions
): Promise<string> =>
  runtime === "openclaw"
    ? promptOpenClaw(options)
    : runtime === "picoclaw"
      ? promptPicoClaw(options)
      : promptTinyClaw(options);
