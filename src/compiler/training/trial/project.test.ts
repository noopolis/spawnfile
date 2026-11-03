import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { compileProject } from "../../compileProject.js";
import { isolateTrialVolumes, TRIAL_VOLUME_PREFIX } from "./boot.js";
import { TRIAL_INSTRUCTIONS_FILE, writeTrialProject } from "./project.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const agent = (name: string): string => `spawnfile_version: "0.1"
kind: agent
name: ${name}
runtime: { name: daimon, options: { engine: codex } }
execution: { model: { primary: { provider: openai, name: gpt-5.4-mini, auth: { method: codex } } } }
schedule: { kind: cron, cron: "0 0 * * *" }
surfaces: { moltnet: [{ network: lab, rooms: { desk: { wake: mentions } } }] }
environment: { mcp_servers: [{ name: tools, tools: [lookup] }] }
workspace: { docs: { system: AGENTS.md } }
`;

/** A team whose members inherit a shared MCP server and a named team volume, as a newsroom does. */
const team = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-trial-project-")); roots.push(root);
  await writeFile(path.join(root, "Spawnfile"), `spawnfile_version: "0.1"
kind: team
name: desk
mode: hierarchical
lead: editor
shared:
  environment:
    mcp_servers: [{ name: tools, transport: stdio, command: /usr/local/bin/node, args: ["\${workspace}/tools/server.mjs"] }]
  workspace:
    docs: { system: TEAM.md }
    resources: [{ id: edition-state, kind: volume, name: desk-edition-state, mount: ./state/edition, mode: mutable, sharing: team }]
members:
  - { id: editor, ref: agents/editor }
  - { id: writer, ref: agents/writer }
networks:
  - { id: lab, name: Lab, provider: moltnet, rooms: [{ id: desk, members: [editor, writer] }], server: { mode: managed, listen: { bind: 0.0.0.0, port: 19962 }, store: { kind: memory }, auth: { mode: none } } }
`);
  await writeFile(path.join(root, "TEAM.md"), "# Team\n");
  for (const name of ["editor", "writer"]) {
    await mkdir(path.join(root, "agents", name), { recursive: true });
    await writeFile(path.join(root, "agents", name, "Spawnfile"), agent(name));
    await writeFile(path.join(root, "agents", name, "AGENTS.md"), `# ${name}\n`);
  }
  return root;
};

it("compiles one team member with its team context, the candidate prompt and nothing federated", async () => {
  const root = await team();
  const trial = await writeTrialProject(path.join(root, "Spawnfile"), path.join(root, "agents/writer/Spawnfile"), "Candidate prompt.", path.join(root, "..", `${path.basename(root)}-trial`));
  roots.push(path.join(root, "..", `${path.basename(root)}-trial`));
  expect(await readFile(path.join(root, "..", `${path.basename(root)}-trial`, TRIAL_INSTRUCTIONS_FILE), "utf8")).toBe("Candidate prompt.");
  const output = path.join(root, "..", `${path.basename(root)}-out`); roots.push(output);
  const compiled = await compileProject(trial.manifestPath, { manifestOverrides: trial.manifestOverrides, outputDirectory: output });
  const container = compiled.report.container!;
  expect(container.runtime_instances.flatMap((instance) => Object.keys(instance.engine_by_node_id ?? {}))).toEqual(["agent:writer"]);
  expect(container.moltnet).toBeUndefined();
  expect(container.workspace_resources?.map((resource) => resource.id)).toEqual(["edition-state"]);
  // The source files were never touched: the trial replaced its manifests in memory only.
  expect(await readFile(path.join(root, "agents/writer/Spawnfile"), "utf8")).toBe(agent("writer"));
  // The team's shared MCP server reaches the member: the agent's narrowing entry would not compile without it.
  expect(JSON.stringify(container.runtime_instances)).toContain("agent:writer");
  const declared = container.persistent_mounts!.find((mount) => mount.volume_name === "desk-edition-state");
  expect(declared).toBeDefined();
  isolateTrialVolumes(container, "trial-a");
  expect(container.persistent_mounts!.every((mount) => mount.volume_name.startsWith(TRIAL_VOLUME_PREFIX) || mount.id.includes("realm"))).toBe(true);
});

it("refuses a subject that is not a member of the project", async () => {
  const root = await team();
  const other = await team();
  await expect(writeTrialProject(path.join(root, "Spawnfile"), path.join(other, "agents/writer/Spawnfile"), "x", path.join(root, "t")))
    .rejects.toThrow("not a referenced member");
  await expect(writeTrialProject(path.join(root, "Spawnfile"), path.join(root, "Spawnfile"), "x", path.join(root, "t")))
    .rejects.toThrow("own agent Spawnfile");
});
