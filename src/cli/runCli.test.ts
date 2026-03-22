import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fileExists, removeDirectory } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import { runCli } from "./runCli.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("runCli", () => {
  it("lists runtime adapters", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(["runtimes"], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message)
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("openclaw");
  });

  it("validates a project", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(["validate", path.join(fixturesRoot, "single-agent")], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message)
    });

    expect(exitCode).toBe(0);
    expect(stdout[0]).toBe("validation succeeded");
  });

  it("compiles a project", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cli-"));
    temporaryDirectories.push(outputDirectory);

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["compile", path.join(fixturesRoot, "single-agent"), "--out", outputDirectory],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain("compiled to");
  }, 30000);

  it("builds a project", async () => {
    const stdout: string[] = [];
    const buildProject = vi.fn(async () => ({
      imageTag: "spawnfile-single-agent",
      outputDirectory: "/tmp/spawnfile-build-out",
      report: {
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "single-agent"),
        spawnfile_version: "0.1" as const
      },
      reportPath: "/tmp/spawnfile-build-out/spawnfile-report.json"
    }));

    const exitCode = await runCli(
      ["build", path.join(fixturesRoot, "single-agent"), "--out", "/tmp/spawnfile-build-out"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { buildProject }
    );

    expect(exitCode).toBe(0);
    expect(buildProject).toHaveBeenCalledWith(path.join(fixturesRoot, "single-agent"), {
      imageTag: undefined,
      outputDirectory: "/tmp/spawnfile-build-out"
    });
    expect(stdout).toEqual([
      "built image spawnfile-single-agent",
      "compiled to /tmp/spawnfile-build-out",
      "report: /tmp/spawnfile-build-out/spawnfile-report.json"
    ]);
  });

  it("runs a project in detached mode", async () => {
    const stdout: string[] = [];
    const runProject = vi.fn(async () => ({
      authProfileName: "dev",
      containerName: "spawnfile-single-agent",
      imageTag: "spawnfile-single-agent",
      outputDirectory: "/tmp/spawnfile-run-out",
      report: {
        container: {
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          ports: [18789],
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
              id: "agent-assistant",
              model_auth_methods: {
                anthropic: "api_key" as const
              },
              model_secrets_required: ["ANTHROPIC_API_KEY"],
              runtime: "openclaw"
            }
          ],
          runtime_homes: ["/var/lib/spawnfile/instances/openclaw/agent-assistant/home"],
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"]
        },
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "single-agent"),
        spawnfile_version: "0.1" as const
      },
      reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json"
    }));

    const exitCode = await runCli(
      [
        "run",
        path.join(fixturesRoot, "single-agent"),
        "--auth-profile",
        "dev",
        "--detach",
        "--out",
        "/tmp/spawnfile-run-out"
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { runProject }
    );

    expect(exitCode).toBe(0);
    expect(runProject).toHaveBeenCalledWith(path.join(fixturesRoot, "single-agent"), {
      authProfile: "dev",
      containerName: undefined,
      detach: true,
      imageTag: undefined,
      outputDirectory: "/tmp/spawnfile-run-out"
    });
    expect(stdout).toEqual([
      "running container spawnfile-single-agent",
      "image: spawnfile-single-agent"
    ]);
  });

  it("imports env auth into a profile", async () => {
    const stdout: string[] = [];
    const importEnvFile = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {
        ANTHROPIC_API_KEY: "ant-key",
        OPENAI_API_KEY: "openai-key"
      },
      imports: {},
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const
    }));

    const exitCode = await runCli(
      ["auth", "import", "env", "/tmp/dev.env", "--profile", "dev"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { importEnvFile }
    );

    expect(exitCode).toBe(0);
    expect(importEnvFile).toHaveBeenCalledWith("dev", "/tmp/dev.env");
    expect(stdout).toEqual([
      "profile: dev",
      "env: ANTHROPIC_API_KEY, OPENAI_API_KEY",
      "imports: none"
    ]);
  });

  it("imports Codex auth into a profile", async () => {
    const stdout: string[] = [];
    const importCodexAuth = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {},
      imports: {
        codex: {
          kind: "codex" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/codex"
        }
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const
    }));

    const exitCode = await runCli(
      ["auth", "import", "codex", "--profile", "dev", "--from", "/tmp/.codex"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { importCodexAuth }
    );

    expect(exitCode).toBe(0);
    expect(importCodexAuth).toHaveBeenCalledWith("dev", "/tmp/.codex");
    expect(stdout).toEqual(["profile: dev", "env: none", "imports: codex"]);
  });

  it("imports Claude Code auth into a profile", async () => {
    const stdout: string[] = [];
    const importClaudeCodeAuth = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {},
      imports: {
        "claude-code": {
          kind: "claude-code" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/claude-code"
        }
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const
    }));

    const exitCode = await runCli(
      ["auth", "import", "claude-code", "--profile", "dev", "--from", "/tmp/.claude"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { importClaudeCodeAuth }
    );

    expect(exitCode).toBe(0);
    expect(importClaudeCodeAuth).toHaveBeenCalledWith("dev", "/tmp/.claude");
    expect(stdout).toEqual(["profile: dev", "env: none", "imports: claude-code"]);
  });

  it("shows an auth profile summary", async () => {
    const stdout: string[] = [];
    const requireAuthProfile = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {
        ANTHROPIC_API_KEY: "ant-key"
      },
      imports: {
        codex: {
          kind: "codex" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/codex"
        }
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const
    }));

    const exitCode = await runCli(
      ["auth", "show", "--profile", "dev"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { requireAuthProfile }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([
      "profile: dev",
      "env: ANTHROPIC_API_KEY",
      "imports: codex"
    ]);
  });

  it("syncs project auth from declared manifest methods", async () => {
    const stdout: string[] = [];
    const syncProjectAuth = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {
        OPENAI_API_KEY: "openai-key"
      },
      imports: {
        codex: {
          kind: "codex" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/codex"
        }
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const
    }));

    const exitCode = await runCli(
      [
        "auth",
        "sync",
        path.join(fixturesRoot, "single-agent"),
        "--profile",
        "dev",
        "--env-file",
        "/tmp/dev.env"
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { syncProjectAuth }
    );

    expect(exitCode).toBe(0);
    expect(syncProjectAuth).toHaveBeenCalledWith(path.join(fixturesRoot, "single-agent"), {
      claudeCodeDirectory: undefined,
      codexDirectory: undefined,
      envFilePath: "/tmp/dev.env",
      profileName: "dev"
    });
    expect(stdout).toEqual([
      "profile: dev",
      "env: OPENAI_API_KEY",
      "imports: codex"
    ]);
  });

  it("initializes a team project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cli-init-"));
    temporaryDirectories.push(directory);

    const stdout: string[] = [];
    const exitCode = await runCli(["init", directory, "--team"], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message)
    });

    expect(exitCode).toBe(0);
    await expect(fileExists(path.join(directory, "TEAM.md"))).resolves.toBe(true);
    expect(stdout[0]).toContain("initialized");
  });

  it("initializes an agent project for a selected runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cli-runtime-init-"));
    temporaryDirectories.push(directory);

    const initProject = vi.fn(async () => ({
      createdFiles: [path.join(directory, "Spawnfile"), path.join(directory, "AGENTS.md")],
      directory
    }));

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["init", directory, "--runtime", "tinyclaw"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message)
      },
      { initProject }
    );

    expect(exitCode).toBe(0);
    expect(initProject).toHaveBeenCalledWith({
      directory,
      runtime: "tinyclaw",
      team: undefined
    });
    expect(stdout[0]).toContain("initialized");
  });

  it("returns a non-zero exit code on errors", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(["validate", path.join(fixturesRoot, "does-not-exist")], {
      stderr: (message) => stderr.push(message),
      stdout: () => undefined
    });

    expect(exitCode).toBe(1);
    expect(stderr[0]).toBeTruthy();
  });

  it("formats Spawnfile errors with their error code", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["validate", path.join(fixturesRoot, "single-agent")],
      {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined
      },
      {
        buildCompilePlan: vi.fn(async () => {
          throw new SpawnfileError("validation_error", "bad auth");
        })
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toEqual(["validation_error: bad auth"]);
  });

  it("formats non-Error failures using String(value)", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["validate", path.join(fixturesRoot, "single-agent")],
      {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined
      },
      {
        buildCompilePlan: vi.fn(async () => {
          throw "plain failure";
        })
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toEqual(["plain failure"]);
  });

  it("uses default process streams when custom streams are not provided", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const exitCode = await runCli(["runtimes"]);

      expect(exitCode).toBe(0);
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("prints commander errors through the default stderr stream", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const exitCode = await runCli(["unknown-command"]);

      expect(exitCode).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
