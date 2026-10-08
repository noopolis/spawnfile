import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";

import { buildCompilePlan } from "./buildCompilePlan.js";
import { preflightCompilePlan } from "./preflightCompilePlan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const writeOrganization = async (agents: Record<string, { docs: string; extra?: string[] }>): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-preflight-"));
  temporaryDirectories.push(directory);
  await writeUtf8File(path.join(directory, "Spawnfile"), [
    'spawnfile_version: "0.1"', "kind: team", "name: studio", "mode: swarm", "members:",
    ...Object.keys(agents).map((name) => `  - { id: ${name}, ref: agents/${name} }`), ""
  ].join("\n"));
  for (const [name, agent] of Object.entries(agents)) {
    await ensureDirectory(path.join(directory, "agents", name));
    await writeUtf8File(path.join(directory, "agents", name, "AGENTS.md"), agent.docs);
    await writeUtf8File(path.join(directory, "agents", name, "Spawnfile"), [
      'spawnfile_version: "0.1"', "kind: agent", `name: ${name}`, "runtime: daimon",
      "workspace: { docs: { system: AGENTS.md } }", ...(agent.extra ?? []), ""
    ].join("\n"));
  }
  return directory;
};

const preflight = async (directory: string): Promise<void> =>
  preflightCompilePlan(await buildCompilePlan(directory));

describe("preflightCompilePlan", () => {
  it("passes an organization compile would accept", async () => {
    await expect(preflight(await writeOrganization({ writer: { docs: "# writer\n" } }))).resolves.toBeUndefined();
  });

  it("reports every agent whose Daimon instructions exceed the public limit, by node id", async () => {
    const oversized = `# big\n${"x".repeat(16_400)}\n`;
    const failure = preflight(await writeOrganization({
      editor: { docs: oversized },
      writer: { docs: "# writer\n" },
      zeta: { docs: oversized }
    }));

    await expect(failure).rejects.toThrow("Compile would refuse 2 agent declaration(s):");
    await expect(failure).rejects.toThrow(/- agent:editor \(daimon\): Daimon organization runtime v1 instructions for agent:editor exceed/u);
    await expect(failure).rejects.toThrow(/- agent:zeta \(daimon\): .*limit 16384 each/u);
  });

  it("reports the instruction limit at the exact byte boundary compile uses", async () => {
    // formatInstructions renders `# system\n\n<content>`; 16_384 bytes total passes, one more fails.
    const prefix = "# system\n\n";
    const atLimit = "y".repeat(16_384 - prefix.length);
    await expect(preflight(await writeOrganization({ writer: { docs: atLimit } }))).resolves.toBeUndefined();
    await expect(preflight(await writeOrganization({ writer: { docs: `${atLimit}y` } }))).rejects.toThrow("agent:writer");
  });

  it("reports adapter refusals compile would raise", async () => {
    const failure = preflight(await writeOrganization({
      writer: {
        docs: "# writer\n",
        extra: ["environment:", "  mcp_servers:", "    - { name: tool, transport: stdio, command: tool, tools: [act] }"]
      }
    }));
    await expect(failure).rejects.toThrow(/- agent:writer \(daimon\): Daimon stdio MCP server tool requires an absolute command/u);
  });

  it("reports runtime-option errors compile would raise", async () => {
    const directory = await writeOrganization({ writer: { docs: "# writer\n" } });
    const manifestPath = path.join(directory, "agents", "writer", "Spawnfile");
    await writeUtf8File(manifestPath, [
      'spawnfile_version: "0.1"', "kind: agent", "name: writer",
      "runtime: { name: daimon, options: { engine: codex, codex_policy: nonsense } }",
      "workspace: { docs: { system: AGENTS.md } }", ""
    ].join("\n"));
    await expect(preflight(directory)).rejects.toThrow(/- agent:writer \(daimon\): /u);
  });
});
