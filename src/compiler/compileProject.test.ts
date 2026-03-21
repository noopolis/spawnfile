import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";

import { compileProject } from "./compileProject.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("compileProject", () => {
  it("compiles a single agent and emits a report", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-compile-"));
    temporaryDirectories.push(outputDirectory);

    const result = await compileProject(path.join(fixturesRoot, "single-agent"), {
      outputDirectory
    });

    await expect(fileExists(result.reportPath)).resolves.toBe(true);
    await expect(
      fileExists(path.join(outputDirectory, "runtimes", "openclaw", "agents", "analyst", "openclaw.json"))
    ).resolves.toBe(true);

    const agentNode = result.report.nodes.find((node) => node.kind === "agent");
    expect(agentNode?.runtime_ref).toBe("v2026.3.13-1");
    expect(agentNode?.runtime_status).toBe("active");
  });

  it("marks a multi-runtime team as degraded at team level", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-"));
    temporaryDirectories.push(outputDirectory);

    const result = await compileProject(path.join(fixturesRoot, "multi-runtime-team"), {
      outputDirectory
    });

    const teamNode = result.report.nodes.find((node) => node.kind === "team");
    expect(teamNode?.capabilities.every((capability) => capability.outcome === "degraded")).toBe(
      true
    );

    const reportJson = await readUtf8File(result.reportPath);
    expect(reportJson).toContain("research-cell");
  });

  it("marks a single-runtime team as degraded when the runtime has no native team compiler", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-single-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "a"));
    await ensureDirectory(path.join(directory, "agents", "b"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "a", "AGENTS.md"), "# A\n");
    await writeUtf8File(path.join(directory, "agents", "b", "AGENTS.md"), "# B\n");
    await writeUtf8File(
      path.join(directory, "agents", "a", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: openclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "b", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: b", "", "runtime: openclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: a",
        "    ref: ./agents/a",
        "  - id: b",
        "    ref: ./agents/b",
        "",
        "structure:",
        "  mode: hierarchical",
        "  leader: a",
        ""
      ].join("\n")
    );

    const result = await compileProject(directory, { outputDirectory: path.join(directory, "out") });
    const teamNode = result.report.nodes.find((node) => node.kind === "team");

    expect(teamNode?.runtime).toBe("openclaw");
    expect(teamNode?.output_dir).toBeNull();
  });

  it("fails when runtime options are invalid", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bad-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Instructions\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: invalid",
        "",
        "runtime:",
        "  name: picoclaw",
        "  options:",
        '    restrict_to_workspace: "yes"',
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(
      compileProject(directory, { outputDirectory: path.join(directory, "dist") })
    ).rejects.toThrow(/restrict_to_workspace/);
  });

  it("emits a native team artifact when the runtime adapter supports teams", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-native-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "a"));
    await ensureDirectory(path.join(directory, "agents", "b"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "a", "AGENTS.md"), "# A\n");
    await writeUtf8File(path.join(directory, "agents", "b", "AGENTS.md"), "# B\n");
    await writeUtf8File(
      path.join(directory, "agents", "a", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: tinyclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "b", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: b", "", "runtime: tinyclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: a",
        "    ref: ./agents/a",
        "  - id: b",
        "    ref: ./agents/b",
        "",
        "structure:",
        "  mode: hierarchical",
        "  leader: a",
        ""
      ].join("\n")
    );

    const outputDirectory = path.join(directory, "out");
    const result = await compileProject(directory, { outputDirectory });
    const teamNode = result.report.nodes.find((node) => node.kind === "team");

    expect(teamNode?.output_dir).toBe("runtimes/tinyclaw/teams/team");
    await expect(
      fileExists(path.join(outputDirectory, "runtimes", "tinyclaw", "teams", "team", "tinyclaw-team.json"))
    ).resolves.toBe(true);
  });

  it("preserves existing output files when clean is disabled", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-no-clean-"));
    temporaryDirectories.push(outputDirectory);

    const sentinelPath = path.join(outputDirectory, "sentinel.txt");
    await writeUtf8File(sentinelPath, "keep\n");

    await compileProject(path.join(fixturesRoot, "single-agent"), {
      clean: false,
      outputDirectory
    });

    await expect(readUtf8File(sentinelPath)).resolves.toBe("keep\n");
  });
});
