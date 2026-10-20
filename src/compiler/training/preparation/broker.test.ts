import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareTrainingBroker, trainingBrokerSkills } from "./broker.js";

it("persists the requested slot count in the strict v2 broker declaration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "training-broker-v2-"));
  try {
    await writeFile(path.join(root, "auth.json"), "fixture", { mode: 0o600 });
    const broker = { maxRunRequests: 17, engine: "grok" as const, agentId: "agent:a", model: "grok-4.6" as const, reasoningEffort: "low" as const,
      architecture: "arm64" as const, limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, realmVolume: "training", bootstrap: "auth.json" };
    const prepared = await prepareTrainingBroker(broker, root, root, true, 3);
    expect(JSON.parse(await readFile(prepared.declarationPath, "utf8"))).toMatchObject({ version: "spawnfile.training-broker.v2", slots: 3, maxRunRequests: 17 });
    expect(prepared.launch.bootstrap).toBe(path.join(root, "auth.json"));
    await expect(prepareTrainingBroker(broker, root, root, false, 9)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("carries the subject's pinned skills into the declaration, refuses changed bytes, and omits the field for none", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "training-broker-skills-"));
  try {
    await writeFile(path.join(root, "auth.json"), "fixture", { mode: 0o600 });
    const skillPath = path.join(root, "SKILL.md"), content = "---\nname: review\n---\nRead first.\n";
    await writeFile(skillPath, content);
    const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const pinned = { sourcePath: skillPath, destinationPath: "skills/review/SKILL.md", sha256, name: "review", ref: "./skills/review", requiresMcp: [] };
    const skills = await trainingBrokerSkills({ skills: [pinned] });
    expect(skills).toEqual([{ name: "review", files: [{ path: "SKILL.md", content }] }]);
    expect(await trainingBrokerSkills({ skills: [] })).toBeUndefined();
    const broker = { maxRunRequests: 17, engine: "grok" as const, agentId: "agent:a", model: "grok-4.6" as const, reasoningEffort: "low" as const,
      architecture: "arm64" as const, limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, realmVolume: "training", bootstrap: "auth.json" };
    const staged = await mkdtemp(path.join(root, "a-")), bare = await mkdtemp(path.join(root, "b-"));
    const prepared = await prepareTrainingBroker(broker, root, staged, true, 2, skills);
    expect(JSON.parse(await readFile(prepared.declarationPath, "utf8")).skills).toEqual(skills);
    const plain = await prepareTrainingBroker(broker, root, bare, true, 2);
    expect(JSON.parse(await readFile(plain.declarationPath, "utf8"))).not.toHaveProperty("skills");
    await writeFile(skillPath, `${content}tampered\n`);
    await expect(trainingBrokerSkills({ skills: [pinned] })).rejects.toMatchObject({ name: "SpawnfileError", message: expect.stringMatching(/changed since its context was captured/u) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
