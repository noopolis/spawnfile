import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fileExists, readUtf8File } from "../filesystem/index.js";

import {
  injectTeamCompileSupportFiles,
  prepareTeamCompileSupport,
  type CompiledNodeOutput
} from "./compileProjectSupport.js";
import {
  createTestAgent,
  createTestPlan,
  createTestTeam
} from "./teamContextSupport.testHelpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("injectTeamCompileSupportFiles", () => {
  it("writes generated team context files into the runtime workspace and appends the pointer block", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-support-"));
    temporaryDirectories.push(directory);

    const teamSource = "/project/Spawnfile";
    const agentSource = "/project/agents/coordinator/Spawnfile";
    const agent = createTestAgent("coordinator", agentSource);
    const team = createTestTeam({
      members: [
        {
          id: "coordinator",
          kind: "agent",
          nodeSource: agentSource,
          runtimeName: "openclaw"
        }
      ],
      name: "Single Team",
      source: teamSource
    });
    const support = await prepareTeamCompileSupport(
      createTestPlan([agent], [team], [
        {
          agentSource,
          memberId: "coordinator",
          teamName: team.name,
          teamSource
        }
      ])
    );
    const compiled: CompiledNodeOutput = {
      emittedFiles: [
        {
          content: "# Existing runtime instructions\n",
          path: "workspace/AGENTS.md"
        }
      ],
      kind: "agent",
      report: { output_dir: "runtimes/openclaw/agents/coordinator" },
      value: agent
    };

    await injectTeamCompileSupportFiles(directory, compiled, support);

    const runtimeDirectory = path.join(directory, compiled.report.output_dir!);
    await expect(
      fileExists(path.join(runtimeDirectory, "workspace", "TEAM.md"))
    ).resolves.toBe(true);
    await expect(
      fileExists(path.join(runtimeDirectory, "workspace", ".spawnfile", "team-contexts.yaml"))
    ).resolves.toBe(true);
    expect(
      await readUtf8File(path.join(runtimeDirectory, "workspace", "AGENTS.md"))
    ).toContain("Read `.spawnfile/team-contexts.md` and `.spawnfile/team-contexts.yaml`");
    expect(compiled.emittedFiles.map((file) => file.path).sort()).toContain(
      "workspace/.spawnfile/team-contexts.yaml"
    );
  });
});
