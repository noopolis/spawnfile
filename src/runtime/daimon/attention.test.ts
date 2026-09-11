import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPiTestNode } from "../pi/testHelpers.js";
import { daimonAdapter } from "./adapter.js";
import { DAIMON_CONFIG_FILE } from "./config.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./contractManifest.js";

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const attest = async (): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-attention-")); roots.push(root);
  const file = path.join(root, "identity.json");
  await writeFile(file, JSON.stringify({
    capability_receipt_sha256: digest("a"), development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    image_architecture: "amd64", image_config_digest: digest("b"), image_manifest_digest: digest("c"),
    image_reference: `127.0.0.1:54321/noopolis/spawnfile-runtime-daimon@${digest("c")}`,
    manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256, registry_authority: "127.0.0.1:54321",
    version: "spawnfile.local-daimon-runtime-identity.v3"
  }));
  process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = file;
};
const compile = async (attention?: unknown) => {
  const node = createPiTestNode({ runtime: { name: "daimon", options: attention === undefined ? {} : { attention } } });
  const compiled = await daimonAdapter.compileAgent(node);
  const [target] = await daimonAdapter.createContainerTargets!([{ emittedFiles: compiled.files, id: "agent:reader", kind: "agent", slug: "reader", value: node }]);
  return JSON.parse(target!.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content);
};
afterEach(async () => {
  delete process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Daimon attention policy compilation", () => {
  it("lowers declared limits into the selected runtime instead of silently dropping them", async () => {
    await attest();
    const attention = { max_batch_messages: 4, max_batch_bytes: 8192, max_executions: 24, max_tokens: 4_000_000 };
    expect(daimonAdapter.validateRuntimeOptions!({ attention })).toEqual([]);
    expect(await compile(attention)).toMatchObject({
      version: "noopolis.daimon.organization-runtime.v2",
      agents: [{ attention: { maxBatchMessages: 4, maxBatchBytes: 8192, maxExecutions: 24, maxTokens: 4_000_000 }, schedule: { kind: "disabled" } }]
    });
  });
  it("preserves omission and makes explicit opt-in defaults visible", async () => {
    const legacy = await compile();
    expect(legacy.version).toBe("noopolis.daimon.organization-runtime.v1");
    expect(legacy.agents[0]).not.toHaveProperty("attention");
    await attest();
    expect((await compile({})).agents[0].attention).toEqual({ maxBatchMessages: 8, maxBatchBytes: 12000 });
  });
  it("refuses attention when the selected runtime does not attest its contract", async () => {
    await expect(compile({})).rejects.toThrow(/attention.*does not attest/iu);
  });
  it.each([
    null, [], "auto", { typo: 1 }, { max_batch_messages: 0 }, { max_batch_messages: 33 },
    { max_batch_bytes: 1023 }, { max_batch_bytes: 12001 }, { max_executions: -1 },
    { max_tokens: 1.5 }, { max_tokens: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects an invalid policy before deployment: %j", async (attention) => {
    expect(daimonAdapter.validateRuntimeOptions!({ attention })).toEqual(expect.arrayContaining([expect.objectContaining({ level: "error" })]));
    await expect(compile(attention)).rejects.toThrow(/attention/iu);
  });
});
