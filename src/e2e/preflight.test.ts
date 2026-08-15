import os from "node:os";
import path from "node:path";

import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File, ensureDirectory } from "../filesystem/index.js";

import {
  exitCodeForE2EPreflight,
  renderE2EPreflightText,
  runB18Preflight,
  type B18PreflightCheck,
  type E2EPreflightReport,
  type PreflightCommandRunner
} from "./preflight.js";

interface StubbedCommand {
  command: string;
  args: string[];
  result?: {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
    timedOut?: boolean;
  };
}

const temporaryDirectories: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-preflight-"));
  temporaryDirectories.push(directory);
  return directory;
};

const createTextFixture = async (filePath: string, content: string): Promise<void> => {
  await ensureDirectory(path.dirname(filePath));
  await writeUtf8File(filePath, content);
};

const createProjectFixture = async (): Promise<string> => {
  return createTempDirectory();
};

const createHomeFixture = async (tokens: { access: string; refresh: string }): Promise<string> => {
  const home = await createTempDirectory();
  await createTextFixture(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: tokens.access, refresh_token: tokens.refresh } }, null, 2)
  );
  await createTextFixture(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "claude-access-token", expiresAt: Date.now() + 60_000 } }, null, 2)
  );
  await createTextFixture(
    path.join(home, ".grok", "auth.json"),
    JSON.stringify(
      { "https://auth.x.ai::11111111-1111-1111-1111-111111111111": { expires_at: "2099-01-01T00:00:00.000Z" } },
      null,
      2
    )
  );
  await createTextFixture(
    path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify(
      { auth_method: "consumer", token: { access_token: "agy-access-token", refresh_token: "agy-refresh-token", token_type: "Bearer" } },
      null,
      2
    )
  );
  return home;
};

const createCommandRunner = (
  stubs: StubbedCommand[],
  fallback: Partial<Awaited<ReturnType<PreflightCommandRunner>>> = {}
): PreflightCommandRunner => {
  const defaultResult = {
    exitCode: fallback.exitCode ?? 0,
    stderr: fallback.stderr ?? "",
    stdout: fallback.stdout ?? "",
    timedOut: fallback.timedOut ?? false
  };
  const matchCommand = (command: string, args: string[]): StubbedCommand | undefined =>
    stubs.find((entry) => entry.command === command && entry.args.every((expectedArg, index) => args[index] === expectedArg));

  return async (command: string, args: string[]) => {
    const stub = matchCommand(command, args);
    if (!stub?.result) {
      return { ...defaultResult };
    }
    return {
      exitCode: stub.result.exitCode ?? 0,
      stderr: stub.result.stderr ?? "",
      stdout: stub.result.stdout ?? "",
      timedOut: stub.result.timedOut ?? false
    };
  };
};

const createFetcher = (
  responses: Array<{ urlIncludes: string; responseInit: ResponseInit & { body?: string } }>
): ((url: string) => Promise<Response>) => {
  return async (url: string) => {
    const hit = responses.find((entry) => url.includes(entry.urlIncludes));
    if (!hit) {
      throw new Error(`No fetcher response configured for ${url}`);
    }
    return new Response(hit.responseInit.body ?? "", {
      ...hit.responseInit,
      statusText: hit.responseInit.statusText ?? "",
      headers: { "content-type": "application/json", ...hit.responseInit.headers }
    });
  };
};

const checkById = (checks: B18PreflightCheck[], id: string): B18PreflightCheck | undefined =>
  checks.find((entry) => entry.id === id);

const createCompileProbe = (
  overrides: Partial<Record<"daimon" | "mneme" | "moltnet" | "openclaw" | "picoclaw", B18PreflightCheck["status"]>> = {}
) => async () => ({
  daimon: {
    id: "daimon",
    name: "Daimon",
    reason: "Mixed-runtime fixture emits Daimon memory wiring",
    status: overrides.daimon ?? "passed"
  },
  mneme: {
    id: "mneme",
    name: "Mneme",
    reason: "Mixed-runtime fixture emits direct and MCP Mneme wiring",
    status: overrides.mneme ?? "passed"
  },
  moltnet: {
    id: "moltnet",
    name: "Moltnet",
    reason: "Mixed-runtime fixture emits Moltnet room topology",
    status: overrides.moltnet ?? "passed"
  },
  openclaw: {
    id: "openclaw",
    name: "OpenClaw",
    reason: "Mixed-runtime fixture emits OpenClaw dream and Mneme MCP wiring",
    status: overrides.openclaw ?? "passed"
  },
  picoclaw: {
    id: "picoclaw",
    name: "PicoClaw",
    reason: "Mixed-runtime fixture emits PicoClaw dream and Mneme MCP wiring",
    status: overrides.picoclaw ?? "passed"
  }
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await removeDirectory(directory);
  }
});

describe("runB18Preflight", () => {
  it("returns passed checks when all required assets and services are mocked as available", async () => {
    const projectRoot = await createProjectFixture();
    const homeDirectory = await createHomeFixture({
      access: "codex-access-token",
      refresh: "codex-refresh-token"
    });
    const commandRunner = createCommandRunner([
      { command: "/tmp/grok", args: ["--version"] },
      { command: "/tmp/agy", args: ["--version"] },
      { command: "docker", args: ["info"] },
      {
        command: "docker",
        args: ["context", "ls", "--format", "{{.Name}} {{.Current}}"],
        result: {
          stdout: "default *\ngpu-host\n"
        }
      },
      { command: "moltnet", args: ["--help"] }
    ]);
    const fetcher = createFetcher([
      { urlIncludes: "/api/tags", responseInit: { status: 200, body: JSON.stringify({ models: [{ name: "llama3.2:1b" }] }) } },
      { urlIncludes: "/api/embeddings", responseInit: { status: 200, body: JSON.stringify({ embedding: new Array(12).fill(0.25) }) } },
      { urlIncludes: "/healthz", responseInit: { status: 200, body: "{}" } }
    ]);

    const result = await runB18Preflight({
      homeDirectory,
      projectRoot,
      runtimeAssetRoot: process.cwd(),
      grokCliCommand: "/tmp/grok",
      antigravityCliCommand: "/tmp/agy",
      compileProbe: createCompileProbe(),
      commandRunner,
      fetcher
    });

    expect(result.readyForLive).toBe(true);
    expect(result.summary.total).toBe(19);
    expect(result.summary.unavailable).toBe(0);
    expect(checkById(result.checks, "codex")?.status).toBe("passed");
    expect(checkById(result.checks, "claude")?.status).toBe("passed");
    expect(checkById(result.checks, "grok")?.status).toBe("passed");
    expect(checkById(result.checks, "grok-auth")?.status).toBe("passed");
    expect(checkById(result.checks, "antigravity")?.status).toBe("passed");
    expect(checkById(result.checks, "antigravity-auth")?.status).toBe("passed");
    expect(checkById(result.checks, "docker-context-list")?.status).toBe("passed");
    expect(checkById(result.checks, "docker-context-gpu-host")?.status).toBe("passed");
    expect(checkById(result.checks, "runtime-assets-openclaw")?.status).toBe("passed");
    expect(checkById(result.checks, "runtime-assets-picoclaw")?.status).toBe("passed");
    expect(checkById(result.checks, "daimon")?.status).toBe("passed");
    expect(checkById(result.checks, "mneme")?.status).toBe("passed");
    expect(checkById(result.checks, "moltnet")?.status).toBe("passed");
    expect(checkById(result.checks, "openclaw")?.status).toBe("passed");
    expect(checkById(result.checks, "picoclaw")?.status).toBe("passed");
    expect(checkById(result.checks, "moltnet-server")?.status).toBe("passed");
  });

  it("marks the remote docker context as skipped when context listing is unavailable", async () => {
    const projectRoot = await createProjectFixture();
    const homeDirectory = await createHomeFixture({
      access: "codex-access-token",
      refresh: "codex-refresh-token"
    });
    const commandRunner = createCommandRunner([
      { command: "/tmp/grok", args: ["--version"] },
      { command: "/tmp/agy", args: ["--version"] },
      { command: "docker", args: ["info"] },
      {
        command: "docker",
        args: ["context", "ls", "--format", "{{.Name}} {{.Current}}"],
        result: {
          exitCode: 1,
          stderr: "daemon disconnected"
        }
      },
      { command: "moltnet", args: ["--help"] }
    ]);

    const result = await runB18Preflight({
      homeDirectory,
      projectRoot,
      runtimeAssetRoot: process.cwd(),
      grokCliCommand: "/tmp/grok",
      antigravityCliCommand: "/tmp/agy",
      compileProbe: createCompileProbe(),
      commandRunner,
      fetcher: createFetcher([
        { urlIncludes: "/api/tags", responseInit: { status: 200, body: JSON.stringify({ models: [{ name: "llama3" }] }) } },
        { urlIncludes: "/api/embeddings", responseInit: { status: 200, body: JSON.stringify({ embedding: [0.1] }) } },
        { urlIncludes: "/healthz", responseInit: { status: 200, body: "{}" } }
      ])
    });

    expect(checkById(result.checks, "docker-context-list")?.status).toBe("unavailable");
    expect(checkById(result.checks, "docker-context-gpu-host")?.status).toBe("skipped");
    expect(checkById(result.checks, "docker-context-gpu-host")?.reason).toContain("unavailable");
  });

  it("does not leak auth secrets while reporting missing token metadata", async () => {
    const projectRoot = await createProjectFixture();
    const homeDirectory = await createHomeFixture({
      access: "codex-secret-access-should-not-appear",
      refresh: "codex-secret-refresh-should-not-appear"
    });
    const commandRunner = createCommandRunner([
      { command: "/tmp/grok", args: ["--version"] },
      { command: "/tmp/agy", args: ["--version"] },
      { command: "docker", args: ["info"] },
      {
        command: "docker",
        args: ["context", "ls", "--format", "{{.Name}} {{.Current}}"],
        result: { stdout: "default *\ngpu-host\n" }
      },
      { command: "moltnet", args: ["--help"] }
    ]);

    const result = await runB18Preflight({
      homeDirectory,
      projectRoot,
      runtimeAssetRoot: process.cwd(),
      grokCliCommand: "/tmp/grok",
      antigravityCliCommand: "/tmp/agy",
      compileProbe: createCompileProbe(),
      commandRunner,
      fetcher: createFetcher([
        { urlIncludes: "/api/tags", responseInit: { status: 200, body: JSON.stringify({ models: [{ name: "llama3" }] }) } },
        { urlIncludes: "/api/embeddings", responseInit: { status: 200, body: JSON.stringify({ embedding: [0.1] }) } },
        { urlIncludes: "/healthz", responseInit: { status: 200, body: "{}" } }
      ])
    });

    const codexReason = checkById(result.checks, "codex")?.reason ?? "";
    expect(codexReason).not.toContain("codex-secret-access-should-not-appear");
    expect(codexReason).not.toContain("codex-secret-refresh-should-not-appear");
  });

  it("marks timeout errors as unavailable for command checks", async () => {
    const projectRoot = await createProjectFixture();
    const homeDirectory = await createHomeFixture({
      access: "codex-access-token",
      refresh: "codex-refresh-token"
    });
    const commandRunner = createCommandRunner([
      { command: "/tmp/grok", args: ["--version"], result: { timedOut: true } },
      { command: "/tmp/agy", args: ["--version"] },
      { command: "docker", args: ["info"] },
      {
        command: "docker",
        args: ["context", "ls", "--format", "{{.Name}} {{.Current}}"],
        result: { stdout: "default *\ngpu-host\n" }
      },
      { command: "moltnet", args: ["--help"] }
    ]);

    const result = await runB18Preflight({
      homeDirectory,
      projectRoot,
      runtimeAssetRoot: process.cwd(),
      grokCliCommand: "/tmp/grok",
      antigravityCliCommand: "/tmp/agy",
      compileProbe: createCompileProbe(),
      commandRunner,
      fetcher: createFetcher([
        { urlIncludes: "/api/tags", responseInit: { status: 200, body: JSON.stringify({ models: [{ name: "llama3" }] }) } },
        { urlIncludes: "/api/embeddings", responseInit: { status: 200, body: JSON.stringify({ embedding: [0.1] }) } },
        { urlIncludes: "/healthz", responseInit: { status: 200, body: "{}" } }
      ])
    });

    expect(checkById(result.checks, "grok")?.status).toBe("unavailable");
    expect(checkById(result.checks, "grok")?.reason).toContain("timed out");
    expect(result.readyForLive).toBe(false);
  });
});

describe("renderE2EPreflightText", () => {
  it("renders readable output and returns exit 1 when unavailable checks remain", () => {
    const report: E2EPreflightReport = {
      checks: [
        {
          category: "auth",
          details: [],
          id: "codex",
          label: "Codex auth",
          reason: "Codex auth file has required token fields",
          status: "ready"
        },
        {
          category: "runtime",
          details: [],
          id: "mneme",
          label: "Mneme",
          reason: "Mixed-runtime fixture did not emit complete Mneme wiring",
          status: "unavailable"
        }
      ],
      generatedAt: "2026-07-09T12:00:00.000Z",
      summary: {
        overall: "attention",
        ready: 1,
        skipped: 0,
        unavailable: 1
      },
      version: "spawnfile.e2e-preflight.v1"
    };

    expect(renderE2EPreflightText(report)).toContain("Spawnfile E2E preflight: attention");
    expect(renderE2EPreflightText(report)).toContain("PASS codex Codex auth");
    expect(renderE2EPreflightText(report)).toContain("UNAVAILABLE mneme Mneme");
    expect(exitCodeForE2EPreflight(report)).toBe(1);
  });
});
