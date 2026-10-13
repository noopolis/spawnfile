import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareTrainingBroker } from "./broker.js";

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
