import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrganizationView } from "../compiler/index.js";
import { removeDirectory } from "../filesystem/index.js";
import { runCli, type CliHandlers } from "./runCli.js";

const repositoryRoot = process.cwd();
const fixturesRoot = path.resolve(repositoryRoot, "fixtures");
const temporaryDirectories: string[] = [];

const createStreams = (): {
  stderr: string[];
  stdout: string[];
  streams: { stderr: (message: string) => void; stdout: (message: string) => void };
} => {
  const stderr: string[] = [];
  const stdout: string[] = [];

  return {
    stderr,
    stdout,
    streams: {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message)
    }
  };
};

const createView = (): OrganizationView => ({
  contexts: [],
  diagnostics: [],
  inputPath: "/tmp/project",
  networks: [
    {
      declaringTeamName: "root-team",
      declaringTeamSource: "/tmp/project/Spawnfile",
      expose: true,
      id: "local_lab",
      name: "Local Lab",
      provider: "moltnet",
      rooms: [
        {
          declaredMembers: ["analyst"],
          id: "mission-control",
          members: [
            {
              agentName: "analyst",
              agentSource: "/tmp/project/agents/analyst/Spawnfile",
              concreteMemberId: "analyst",
              declaredSlot: "analyst",
              directTeamName: "root-team",
              directTeamSource: "/tmp/project/Spawnfile"
            }
          ]
        }
      ]
    }
  ],
  root: {
    children: [],
    displayName: "analyst",
    id: "agent:analyst",
    kind: "agent",
    name: "analyst",
    runtimeName: "openclaw",
    source: "/tmp/project/Spawnfile"
  },
  runtimes: []
});

const createForbiddenProjectHandlers = (): Pick<
  CliHandlers,
  "buildProject" | "compileProject" | "runProject"
> => ({
  buildProject: vi.fn(async () => {
    throw new Error("buildProject should not run");
  }),
  compileProject: vi.fn(async () => {
    throw new Error("compileProject should not run");
  }),
  runProject: vi.fn(async () => {
    throw new Error("runProject should not run");
  })
});

const withTemporaryCwd = async (run: () => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cli-view-"));
  temporaryDirectories.push(directory);
  const previousCwd = process.cwd();
  process.chdir(directory);

  try {
    await run();
  } finally {
    process.chdir(previousCwd);
  }
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("view command", () => {
  it("renders the default tree for a project directory without project build handlers", async () => {
    const { streams, stdout } = createStreams();
    const handlers = createForbiddenProjectHandlers();

    const exitCode = await runCli(["view", path.join(fixturesRoot, "single-agent")], {
      handlers,
      renderEnvironment: { ci: false, noColor: true, stdoutIsTty: false },
      streams
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("agent analyst [openclaw]");
    expect(handlers.compileProject).not.toHaveBeenCalled();
    expect(handlers.buildProject).not.toHaveBeenCalled();
    expect(handlers.runProject).not.toHaveBeenCalled();
  });

  it("renders the default tree for a direct Spawnfile path", async () => {
    const { streams, stdout } = createStreams();
    const inputPath = path.join(fixturesRoot, "single-agent", "Spawnfile");

    const exitCode = await runCli(["view", inputPath], {
      renderEnvironment: { ci: false, noColor: true, stdoutIsTty: false },
      streams
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("agent analyst [openclaw]");
  });

  it("renders Moltnet networks mode", async () => {
    const { streams, stdout } = createStreams();

    const exitCode = await runCli(
      ["view", path.join(fixturesRoot, "e2e", "moltnet-team-chat"), "--mode", "networks"],
      {
        renderEnvironment: { ci: false, noColor: true, stdoutIsTty: false },
        streams
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("Moltnet networks");
    expect(stdout.join("\n")).toContain(
      "local_lab \"Local Lab\" on moltnet-team-chat server=managed auth=none human_ingress"
    );
  });

  it("accepts comma-separated --show layers", async () => {
    const buildOrganizationView = vi.fn(async () => createView());
    const { streams, stdout } = createStreams();

    const exitCode = await runCli(
      ["view", "/tmp/project", "--mode", "networks", "--show", "paths,declared"],
      { handlers: { buildOrganizationView }, streams }
    );

    const output = stdout.join("\n");
    expect(exitCode).toBe(0);
    expect(output).toContain("room mission-control declared [analyst]");
    expect(output).toContain("</tmp/project/Spawnfile>");
    expect(output).toContain("</tmp/project/agents/analyst/Spawnfile>");
  });

  it("merges --paths with --show declared", async () => {
    const buildOrganizationView = vi.fn(async () => createView());
    const { streams, stdout } = createStreams();

    const exitCode = await runCli(
      ["view", "/tmp/project", "--mode", "networks", "--show", "declared", "--paths"],
      { handlers: { buildOrganizationView }, streams }
    );

    const output = stdout.join("\n");
    expect(exitCode).toBe(0);
    expect(output).toContain("room mission-control declared [analyst]");
    expect(output).toContain("</tmp/project/Spawnfile>");
  });

  it("treats --paths as --show paths", async () => {
    const buildOrganizationView = vi.fn(async () => createView());
    const pathsFlag = createStreams();
    const showPaths = createStreams();

    await runCli(["view", "/tmp/project", "--paths"], {
      handlers: { buildOrganizationView },
      streams: pathsFlag.streams
    });
    await runCli(["view", "/tmp/project", "--show", "paths"], {
      handlers: { buildOrganizationView },
      streams: showPaths.streams
    });

    expect(pathsFlag.stdout).toEqual(showPaths.stdout);
    expect(pathsFlag.stdout.join("\n")).toContain("</tmp/project/Spawnfile>");
  });

  it("treats an implemented mode token as a path when that Spawnfile resolves", async () => {
    await withTemporaryCwd(async () => {
      await mkdir(path.join(process.cwd(), "networks"));
      await writeFile(path.join(process.cwd(), "networks", "Spawnfile"), "");
      const buildOrganizationView = vi.fn(async () => createView());
      const { streams } = createStreams();

      const exitCode = await runCli(["view", "networks"], {
        handlers: { buildOrganizationView },
        renderEnvironment: { ci: false, noColor: true, stdoutIsTty: false },
        streams
      });

      expect(exitCode).toBe(0);
      expect(buildOrganizationView).toHaveBeenCalledWith("networks");
    });
  });

  it("suggests --mode when an implemented mode token has no Spawnfile path", async () => {
    await withTemporaryCwd(async () => {
      const buildOrganizationView = vi.fn(async () => createView());
      const { stderr, streams } = createStreams();

      const exitCode = await runCli(["view", "networks"], {
        handlers: { buildOrganizationView },
        streams
      });

      expect(exitCode).toBe(2);
      expect(buildOrganizationView).not.toHaveBeenCalled();
      expect(stderr.join("\n")).toContain("spawnfile view --mode networks");
    });
  });

  it.each(["contexts", "runtimes"])("does not suggest future mode %s", async (token) => {
    await withTemporaryCwd(async () => {
      const buildOrganizationView = vi.fn(async () => {
        throw new Error(`handled ${token} as path`);
      });
      const { stderr, streams } = createStreams();

      const exitCode = await runCli(["view", token], {
        handlers: { buildOrganizationView },
        streams
      });

      expect(exitCode).toBe(1);
      expect(buildOrganizationView).toHaveBeenCalledWith(token);
      expect(stderr.join("\n")).toContain(`handled ${token} as path`);
      expect(stderr.join("\n")).not.toContain(`--mode ${token}`);
    });
  });

  it.each([
    ["--mode", "contexts"],
    ["--show", "runtimes"],
    ["--color", "sometimes"]
  ])("rejects invalid %s value", async (flag, value) => {
    const buildOrganizationView = vi.fn(async () => createView());
    const { stderr, streams } = createStreams();

    const exitCode = await runCli(["view", flag, value], {
      handlers: { buildOrganizationView },
      streams
    });

    expect(exitCode).toBe(2);
    expect(buildOrganizationView).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toMatch(new RegExp(value));
  });

  it.each([
    ["paths,diagnostics", "diagnostics"],
    ["declared,capabilities", "capabilities"],
    ["paths,custom", "custom"]
  ])("rejects invalid comma-separated --show layer %s", async (value, invalidLayer) => {
    const buildOrganizationView = vi.fn(async () => createView());
    const { stderr, streams } = createStreams();

    const exitCode = await runCli(["view", "--show", value], {
      handlers: { buildOrganizationView },
      streams
    });

    expect(exitCode).toBe(2);
    expect(buildOrganizationView).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain(invalidLayer);
  });

  it("shows only Phase 1 view options in help", async () => {
    const { streams, stdout } = createStreams();

    const exitCode = await runCli(["view", "--help"], { streams });
    const help = stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(help).toContain("--mode <mode>");
    expect(help).toContain("--show <show>");
    expect(help).toContain("--ascii");
    expect(help).toContain("--color <when>");
    expect(help).toContain("--paths");
    expect(help).not.toContain("contexts");
    expect(help).not.toContain("runtimes");
  });

  it("resolves color from injected render environment and --color overrides", async () => {
    const buildOrganizationView = vi.fn(async () => createView());
    const tty = createStreams();
    const noColor = createStreams();
    const forced = createStreams();

    await runCli(["view", "/tmp/project"], {
      handlers: { buildOrganizationView },
      renderEnvironment: { ci: false, noColor: false, stdoutIsTty: true },
      streams: tty.streams
    });
    await runCli(["view", "/tmp/project"], {
      handlers: { buildOrganizationView },
      renderEnvironment: { ci: false, noColor: true, stdoutIsTty: true },
      streams: noColor.streams
    });
    await runCli(["view", "/tmp/project", "--color", "always"], {
      handlers: { buildOrganizationView },
      renderEnvironment: { ci: true, noColor: true, stdoutIsTty: false },
      streams: forced.streams
    });

    expect(tty.stdout.join("\n")).toContain("\u001b[32magent\u001b[0m analyst");
    expect(noColor.stdout.join("\n")).not.toContain("\u001b[32magent");
    expect(forced.stdout.join("\n")).toContain("\u001b[32magent\u001b[0m analyst");
  });

  it("routes help and invalid parse output through injected streams", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { stderr, streams, stdout } = createStreams();

    try {
      const helpExitCode = await runCli(["view", "--help"], { streams });
      const errorExitCode = await runCli(["view", "--color", "sometimes"], { streams });

      expect(helpExitCode).toBe(0);
      expect(errorExitCode).toBe(2);
      expect(stdout.join("\n")).toContain("Usage: spawnfile view");
      expect(stderr.join("\n")).toContain("sometimes");
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
