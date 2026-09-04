import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const LOCAL_DAIMON_IMAGE_REPOSITORY = "127.0.0.1:54321/noopolis/spawnfile-runtime-daimon";
import type { ResolvedAgentNode } from "../../compiler/types.js";
import { createPiTestNode } from "../pi/testHelpers.js";
import { daimonAdapter } from "./adapter.js";
import { DAIMON_CONFIG_FILE } from "./config.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./contractManifest.js";

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const identity = async (manifestSha256: string = DAIMON_CONTRACT_MANIFEST_SHA256): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-schedule-authority-")); roots.push(root);
  const file = path.join(root, "identity.json");
  await writeFile(file, `${JSON.stringify({
    capability_receipt_sha256: digest("a"), development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    image_architecture: "amd64", image_config_digest: digest("b"), image_manifest_digest: digest("c"),
    image_reference: `${LOCAL_DAIMON_IMAGE_REPOSITORY}@${digest("c")}`, manifest_sha256: manifestSha256,
    registry_authority: "127.0.0.1:54321", version: "spawnfile.local-daimon-runtime-identity.v3"
  })}\n`);
  return file;
};
const scheduledTarget = async (kind: "every" | "disabled" = "every") => {
  const node = createPiTestNode({ runtime: { name: "daimon", options: {} }, schedule: kind === "every" ? { kind, every: "1m", prompt: "work" } : { kind } });
  const compiled = await daimonAdapter.compileAgent(node);
  return await daimonAdapter.createContainerTargets!([{ emittedFiles: compiled.files, id: "agent:scheduled", kind: "agent", slug: "scheduled", value: node }]);
};

afterEach(async () => { delete process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Daimon schedule image authority", () => {
  it("fails closed for the pinned v1 image while v1 unscheduled compilation remains valid", async () => {
    await expect(daimonAdapter.compileAgent(createPiTestNode({
      runtime: { name: "daimon", options: {} }, schedule: { every: "1m", kind: "every" }
    }))).resolves.toMatchObject({ capabilities: expect.arrayContaining([
      expect.objectContaining({ key: "agent.schedule", outcome: "degraded" })
    ]) });
    await expect(scheduledTarget()).rejects.toThrow(/does not attest organization runtime v2/u);
    const node = createPiTestNode({ runtime: { name: "daimon", options: {} } });
    const compiled = await daimonAdapter.compileAgent(node);
    const targets = await daimonAdapter.createContainerTargets!([{ emittedFiles: compiled.files, id: "agent:v1", kind: "agent", slug: "v1", value: node }]);
    expect(JSON.parse(targets[0]!.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content).version).toBe("noopolis.daimon.organization-runtime.v1");
  });

  it("supports active and disabled v2 states only with the canonical local receipt authority", async () => {
    process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = await identity();
    for (const kind of ["every", "disabled"] as const) {
      const node = createPiTestNode({ runtime: { name: "daimon", options: {} }, schedule: kind === "every" ? { kind, every: "1m", prompt: "work" } : { kind } });
      const compiled = await daimonAdapter.compileAgent(node);
      expect(compiled.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "agent.schedule",
          message: expect.stringContaining(kind === "disabled" ? "state: disabled" : "state: supported"),
          outcome: "supported"
        })
      ]));
      const targets = await scheduledTarget(kind);
      expect(JSON.parse(targets[0]!.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content).version).toBe("noopolis.daimon.organization-runtime.v2");
    }
    process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = await identity(digest("d"));
    await expect(scheduledTarget()).rejects.toThrow(/Local Daimon runtime identity is invalid or incomplete/u);
  });

  it("lowers schedule.jitter_seconds into the v2 config for cron and every schedules, and omits it when absent", async () => {
    process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = await identity();
    const configFor = async (schedule: NonNullable<ResolvedAgentNode["schedule"]>, slug: string) => {
      const node = createPiTestNode({ runtime: { name: "daimon", options: {} }, schedule });
      const compiled = await daimonAdapter.compileAgent(node);
      const targets = await daimonAdapter.createContainerTargets!([{ emittedFiles: compiled.files, id: `agent:${slug}`, kind: "agent", slug, value: node }]);
      return JSON.parse(targets[0]!.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content);
    };

    const cronConfig = await configFor({ kind: "cron", cron: "0 10 * * *", timezone: "Europe/Berlin", prompt: "work", jitter_seconds: 900 }, "cron");
    expect(cronConfig.agents[0].schedule).toEqual({
      cron: "0 10 * * *", jitter_seconds: 900, kind: "cron", prompt: "work", timezone: "Europe/Berlin"
    });

    const everyConfig = await configFor({ kind: "every", every: "5m", prompt: "work", jitter_seconds: 30 }, "every-jittered");
    expect(everyConfig.agents[0].schedule).toEqual({ interval_ms: 300_000, jitter_seconds: 30, kind: "every", prompt: "work" });

    const noJitterConfig = await configFor({ kind: "every", every: "5m", prompt: "work" }, "every-plain");
    expect(noJitterConfig.agents[0].schedule).not.toHaveProperty("jitter_seconds");
  });
});
