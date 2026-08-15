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

// OpenClaw/PicoClaw publish their health port to the host. The Daimon/Pi
// control server (appControlSource.ts) instead listens on the container's
// loopback at PI_CONTROL_PORT, so it is only reachable via `docker exec`.
const DAIMON_CONTROL_PORT = 19690;
const DAIMON_CONTROL_BASE = `http://127.0.0.1:${DAIMON_CONTROL_PORT}`;

const getHealthUrl = (runtime: E2ERuntime): string =>
  runtime === "openclaw"
    ? "http://127.0.0.1:18789/healthz"
    : "http://127.0.0.1:18990/health";

interface RuntimeReadyOptions {
  command?: string;
  containerName?: string;
  timeoutMs?: number;
}

// The daimon container ships Node but not curl (node:24-bookworm-slim), so the
// probe runs a tiny fetch via `node --eval` inside the container.
const dockerExecNode = async (
  command: string,
  containerName: string,
  script: string,
  env: Record<string, string> = {},
  timeoutMs?: number
): Promise<string> => {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const result = await runCommand(
    command,
    ["exec", ...envArgs, containerName, "node", "--eval", script],
    timeoutMs
  );
  return result.stdout;
};

const waitForDaimonReady = async (
  options: RuntimeReadyOptions,
  timeoutMs: number
): Promise<void> => {
  if (!options.containerName) {
    throw new SpawnfileError(
      "runtime_error",
      "Daimon readiness check requires a containerName to docker exec into"
    );
  }
  const startedAt = Date.now();
  const script =
    `fetch("${DAIMON_CONTROL_BASE}/healthz")` +
    `.then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await dockerExecNode(options.command ?? "docker", options.containerName, script, {}, 15_000);
      return;
    } catch {
      // Ignore readiness races and keep polling.
    }
    await wait(2_000);
  }

  throw new SpawnfileError(
    "runtime_error",
    `Runtime daimon did not become ready within ${timeoutMs}ms (${DAIMON_CONTROL_BASE}/healthz in ${options.containerName})`
  );
};

export const waitForRuntimeReady = async (
  runtime: E2ERuntime,
  options: RuntimeReadyOptions = {}
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (runtime === "daimon") {
    await waitForDaimonReady(options, timeoutMs);
    return;
  }

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

// Daimon has no one-shot prompt CLI like openclaw/picoclaw: it is a wake-driven
// service. So the probe (via `docker exec node`) looks up the agent slug from
// the control server, POSTs a tokenless loopback delivery wake carrying the
// prompt, and returns the reply text the wake response echoes back
// (executeAgentWake -> { from, message } in appControlSource.ts). The reply is
// the real model output, so the caller's exact-sentinel check works unchanged.
const promptDaimon = async (options: RuntimePromptOptions): Promise<string> => {
  if (!options.containerName) {
    throw new SpawnfileError(
      "runtime_error",
      "Daimon prompt requires a containerName to docker exec into"
    );
  }
  const script = String.raw`
    (async () => {
      const base = "${DAIMON_CONTROL_BASE}";
      const list = await (await fetch(base + "/spawnfile/agents")).json();
      const slug = list && list.agents && list.agents[0] && list.agents[0].slug;
      if (!slug) { process.stderr.write("no daimon agent slug from /spawnfile/agents"); process.exit(1); }
      const body = {
        event_id: "moltnet:e2e-auth-" + Date.now(),
        from: "e2e-harness",
        to: slug,
        context_id: "e2e-auth",
        message: process.env.SF_E2E_PROMPT,
        kind: "message"
      };
      const res = await fetch(base + "/agents/" + encodeURIComponent(slug) + "/wake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      process.stdout.write(String((json && (json.message || json.error)) || ""));
    })().catch((error) => { process.stderr.write(String((error && error.message) || error)); process.exit(1); });
  `;
  return dockerExecNode(
    options.command ?? "docker",
    options.containerName,
    script,
    { SF_E2E_PROMPT: options.prompt },
    options.timeoutMs
  );
};

export const promptRuntime = async (
  runtime: E2ERuntime,
  options: RuntimePromptOptions
): Promise<string> => {
  if (runtime === "daimon") {
    return promptDaimon(options);
  }
  return runtime === "openclaw"
    ? promptOpenClaw(options)
    : promptPicoClaw(options);
};
