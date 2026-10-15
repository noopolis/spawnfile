import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { createTrainingContext } from "../context.js";
import { trainingContextSchema } from "../contract.js";
import { fixture } from "./fixtures.test-helper.js";
import { assertTrainingSubjectIsolation } from "./subjectIsolation.js";

it("resolves the selected subject and default Codex engine without extending the v1 context", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.project, "AGENTS.md"), "Subject instructions\n");
    const workspace = { docs: { system: "AGENTS.md" } };
    await writeFile(path.join(f.project, "Spawnfile"), stringify({
      spawnfile_version: "0.1", kind: "team", name: "subjects", mode: "swarm", members: [
        { id: "strict", workspace, runtime: { name: "daimon", options: { codex_policy: "workspace-no-network" } },
          execution: { sandbox: { mode: "workspace" } } },
        { id: "ordinary", workspace, runtime: "daimon" }
      ]
    }));
    const context = await createTrainingContext(f.project, { agent: "strict", packageVersion: "test" });
    const config = { subjectIsolation: "codex-native-sandbox" as const };
    expect(context.version).toBe("spawnfile.training-context.v1");
    expect(context.agent.engine).toBeNull();
    expect(Object.keys(JSON.parse(JSON.stringify(context)).agent).sort()).toEqual([
      "engine", "id", "model", "name", "runtime", "source"
    ]);
    expect(trainingContextSchema.safeParse({ ...context, version: "spawnfile.training-context.v2" }).success).toBe(false);
    expect(trainingContextSchema.safeParse({ ...context, agent: { ...context.agent, codexSandbox: null } }).success).toBe(false);
    await expect(assertTrainingSubjectIsolation(config, context)).resolves.toBeUndefined();
    // A strict peer and forged wire engine must not authorize the ordinary selected subject.
    const ordinary = await createTrainingContext(f.project, { agent: "ordinary", packageVersion: "test" });
    await expect(assertTrainingSubjectIsolation(config, { ...ordinary, agent: { ...ordinary.agent, engine: "codex" } }))
      .rejects.toThrow("strict codex_policy");
    await expect(assertTrainingSubjectIsolation(config, { ...context, agent: { ...context.agent, id: "agent:missing" } }))
      .rejects.toThrow("No canonical agent");
    await rm(context.project.manifest);
    await expect(assertTrainingSubjectIsolation(config, context)).rejects.toThrow();
    await expect(assertTrainingSubjectIsolation({}, context)).resolves.toBeUndefined();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
