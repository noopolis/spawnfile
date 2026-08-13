import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle, type TargetResourceExportIndex } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import {
  EVIDENCE_EXPORT_HELPER_CONTRACT,
  createEvidenceExportHandle,
  createEvidenceExportHelper,
  evidenceReceiptLabels,
  parseEvidenceVolumeAuthority,
} from "./evidenceExportProvider.js";
import { initializeEvidenceExportAuthorityStore, type EvidenceExportAdmission } from "./evidenceExportStore.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-export-store-validation-")));
  roots.push(value);
  return value;
};
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

const admission = (): EvidenceExportAdmission => {
  const selected = parseOpaqueTargetHandle("opaque_dddddddddddddddd");
  const volume = createDockerResourceSpec({
    kind: "evidence_volume",
    operationHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee"),
    requestDigest: `sha256:${"f".repeat(64)}`,
    runId: "run-one",
    selectedTargetHandle: selected,
  });
  return {
    descriptor_digest: `sha256:${"a".repeat(64)}`,
    evidence_volume: parseEvidenceVolumeAuthority({ labels: volume.labels, name: volume.name, resultHandle: volume.resultHandle }),
    helper: createEvidenceExportHelper({
      artifactManifestDigest: `sha256:${"b".repeat(64)}`,
      imageDigest: `sha256:${"c".repeat(64)}`,
      imageReference: `registry.example/export@sha256:${"c".repeat(64)}`,
      resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb"),
    }),
    helper_contract: EVIDENCE_EXPORT_HELPER_CONTRACT,
    operation_handle: parseOpaqueTargetHandle("opaque_cccccccccccccccc"),
    request_digest: `sha256:${"d".repeat(64)}`,
    run_id: "run-one",
    selected_target: { fingerprint: `sha256:${"e".repeat(32)}`, handle: selected },
    version: "spawnfile.target-evidence-export.private.v1",
  };
};

const ordinary = (): Record<string, unknown> => JSON.parse(JSON.stringify(admission())) as Record<string, unknown>;
const exportedIndex = (value: EvidenceExportAdmission): TargetResourceExportIndex => ({
  evidence_digest: `sha256:${"9".repeat(64)}`,
  export_handle: createEvidenceExportHandle({
    evidenceVolumeHandle: value.evidence_volume.resultHandle,
    operationHandle: value.operation_handle,
    requestDigest: value.request_digest,
  }),
  files: [],
  item_count: 0,
  labels: evidenceReceiptLabels(value.evidence_volume),
  run_id: value.run_id,
  source: { evidence_volume_handle: value.evidence_volume.resultHandle, state: "preserved" },
  state: "exported",
  version: "spawnfile.target-resource.export-index.v1",
});
const fileWithSuffix = async (directory: string, suffix: string): Promise<string> => {
  const found = (await readdir(directory)).find((entry) => entry.endsWith(suffix));
  if (!found) throw new Error(`missing ${suffix}`);
  return path.join(directory, found);
};

describe("evidence export authority store validation", () => {
  it("creates a private nested root and rejects unusable authority roots", async () => {
    const parent = await root();
    const nested = path.join(parent, "new", "store");
    await expect(initializeEvidenceExportAuthorityStore(nested)).resolves.toBeDefined();
    expect((await stat(nested)).mode & 0o777).toBe(0o700);

    await expect(initializeEvidenceExportAuthorityStore(null)).rejects.toThrow("Evidence-volume export failed");
    await expect(initializeEvidenceExportAuthorityStore("")).rejects.toThrow("Evidence-volume export failed");
    await expect(initializeEvidenceExportAuthorityStore("x".repeat(4_097))).rejects.toThrow("Evidence-volume export failed");
    await expect(initializeEvidenceExportAuthorityStore(path.parse(parent).root)).rejects.toThrow("Evidence-volume export failed");

    const file = path.join(parent, "ordinary-file");
    await writeFile(file, "x", { mode: 0o600 });
    await expect(initializeEvidenceExportAuthorityStore(path.join(file, "child"))).rejects.toThrow("Evidence-volume export failed");

    const wrongMode = path.join(parent, "wrong-mode");
    await mkdir(wrongMode, { mode: 0o700 });
    await chmod(wrongMode, 0o755);
    await expect(initializeEvidenceExportAuthorityStore(wrongMode)).rejects.toThrow("Evidence-volume export failed");

    const link = path.join(parent, "linked-root");
    await symlink(nested, link);
    await expect(initializeEvidenceExportAuthorityStore(link)).rejects.toThrow("Evidence-volume export failed");
  });

  it("rejects malformed admission fields at each private authority boundary", async () => {
    const store = await initializeEvidenceExportAuthorityStore(await root());
    const base = ordinary();
    const selected = base.selected_target as Record<string, unknown>;
    const helper = base.helper as Record<string, unknown>;
    const malformed: readonly unknown[] = [
      null,
      [],
      { ...base, unexpected: true },
      { ...base, version: "spawnfile.target-evidence-export.private.v2" },
      { ...base, helper_contract: "other" },
      { ...base, request_digest: null },
      { ...base, request_digest: "sha256:bad" },
      { ...base, descriptor_digest: null },
      { ...base, descriptor_digest: "sha256:bad" },
      { ...base, run_id: null },
      { ...base, selected_target: null },
      { ...base, selected_target: [] },
      { ...base, selected_target: { ...selected, unexpected: true } },
      { ...base, selected_target: { ...selected, fingerprint: null } },
      { ...base, selected_target: { ...selected, fingerprint: "sha256:bad" } },
      { ...base, selected_target: { ...selected, handle: "not-opaque" } },
      { ...base, helper: null },
      { ...base, helper: { ...helper, unexpected: true } },
      { ...base, helper: { ...helper, image_digest: "sha256:bad" } },
      { ...base, evidence_volume: null },
      { ...base, operation_handle: "not-opaque" },
      { ...base, run_id: "run-two" },
    ];

    for (const [index, value] of malformed.entries()) {
      await expect(store.bindAdmission(value as never), `malformed admission ${index + 1}`)
        .rejects.toThrow("Evidence-volume export failed");
    }
  });

  it("loads only a present valid admission and rejects persisted corruption", async () => {
    const directory = await root();
    const store = await initializeEvidenceExportAuthorityStore(directory);
    const value = admission();

    await expect(store.loadAdmission(value.operation_handle)).rejects.toThrow("Evidence-volume export failed");
    await expect(store.loadAdmission("not-opaque" as never)).rejects.toThrow();
    await store.bindAdmission(value);
    await expect(store.loadAdmission(value.operation_handle)).resolves.toEqual(value);

    const file = await fileWithSuffix(directory, ".admission.json");
    await writeFile(file, "{", "utf8");
    await expect(store.loadAdmission(value.operation_handle)).rejects.toThrow("Evidence-volume export failed");
  });

  it("rejects hostile admission-file types, link counts, sizes, and modes", async () => {
    const mutations: ReadonlyArray<(file: string) => Promise<void>> = [
      async (file) => { await unlink(file); await mkdir(file); },
      async (file) => { await link(file, `${file}.peer`); },
      async (file) => { await truncate(file, 65_537); },
      async (file) => { await chmod(file, 0o640); },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const directory = await root();
      const store = await initializeEvidenceExportAuthorityStore(directory);
      const value = admission();
      await store.bindAdmission(value);
      await mutate(await fileWithSuffix(directory, ".admission.json"));
      await expect(store.loadAdmission(value.operation_handle), `hostile admission file ${index + 1}`)
        .rejects.toThrow("Evidence-volume export failed");
    }
  });

  it("fails closed when filesystem policy blocks admission and claim lookup", async () => {
    const admissionDirectory = await root();
    const value = admission();
    const admissionStore = await initializeEvidenceExportAuthorityStore(admissionDirectory);
    await admissionStore.bindAdmission(value);
    await chmod(admissionDirectory, 0o000);
    try {
      await expect(admissionStore.loadAdmission(value.operation_handle)).rejects.toThrow("Evidence-volume export failed");
    } finally {
      await chmod(admissionDirectory, 0o700);
    }

    const claimDirectory = await root();
    const claimStore = await initializeEvidenceExportAuthorityStore(claimDirectory, { createToken: () => "0".repeat(64) });
    await claimStore.claimExport(value);
    await chmod(claimDirectory, 0o000);
    try {
      await expect(claimStore.claimExport(value)).rejects.toThrow("Evidence-volume export failed");
    } finally {
      await chmod(claimDirectory, 0o700);
    }
  });

  it("binds a destination commitment and rejects absent, mismatched, and corrupt records", async () => {
    const directory = await root();
    const store = await initializeEvidenceExportAuthorityStore(directory);
    const value = admission();
    const destination = "/operator/private/export.tar";

    await expect(store.bindDestination(value, null as never)).rejects.toThrow("Evidence-volume export failed");
    await expect(store.requireDestination(value, null as never)).rejects.toThrow("Evidence-volume export failed");
    await expect(store.requireDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
    await store.bindDestination(value, destination);
    await expect(store.requireDestination(value, destination)).resolves.toBeUndefined();
    await expect(store.requireDestination(value, `${destination}.other`)).rejects.toThrow("Evidence-volume export failed");

    const file = await fileWithSuffix(directory, ".destination.json");
    const original = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const corruptions: readonly unknown[] = [
      { ...original, unexpected: true },
      { ...original, version: "spawnfile.target-evidence-export.private.v2" },
      { ...original, commitment: null },
      { ...original, commitment: "0".repeat(64) },
    ];
    for (const [index, corrupted] of corruptions.entries()) {
      await writeFile(file, JSON.stringify(corrupted), "utf8");
      await expect(store.requireDestination(value, destination), `corrupt destination ${index + 1}`)
        .rejects.toThrow("Evidence-volume export failed");
    }
    await writeFile(file, "{", "utf8");
    await expect(store.requireDestination(value, destination)).rejects.toThrow("Evidence-volume export failed");
  });

  it("validates every export-index correlation and canonical persisted bytes", async () => {
    const directory = await root();
    const store = await initializeEvidenceExportAuthorityStore(directory);
    const value = admission();
    const index = exportedIndex(value);
    const wrongHandle = parseOpaqueTargetHandle("opaque_ffffffffffffffff");
    const drifts: readonly unknown[] = [
      null,
      { ...index, state: "incomplete" },
      { ...index, run_id: "run-two" },
      { ...index, source: { ...index.source, evidence_volume_handle: wrongHandle } },
      { ...index, export_handle: wrongHandle },
      { ...index, labels: index.labels.map((label, position) => position === 0 ? { ...label, value: "drifted" } : label) },
    ];
    for (const [position, drifted] of drifts.entries()) {
      await expect(store.bindIndex(value, drifted as never), `index drift ${position + 1}`)
        .rejects.toThrow();
    }

    await expect(store.loadIndex(value)).resolves.toBeNull();
    const bytes = await store.bindIndex(value, index);
    await expect(store.loadIndex(value)).resolves.toEqual({ index, bytes });

    const file = await fileWithSuffix(directory, ".index.json");
    await writeFile(file, `${bytes}\n`, "utf8");
    await expect(store.loadIndex(value)).rejects.toThrow("Evidence-volume export failed");
    await writeFile(file, "{", "utf8");
    await expect(store.loadIndex(value)).rejects.toThrow("Evidence-volume export failed");
  });

  it("rejects invalid claim inputs and preserves a claim for its exact owner token", async () => {
    const directory = await root();
    const value = admission();
    const invalidToken = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "bad" });
    await expect(invalidToken.claimExport(value)).rejects.toThrow("Evidence-volume export failed");

    const store = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "1".repeat(64) });
    await expect(store.releaseExport(value, null as never)).rejects.toThrow("Evidence-volume export failed");
    await expect(store.releaseExport(value, { token: "bad" })).rejects.toThrow("Evidence-volume export failed");
    await expect(store.releaseExport(value, { token: "2".repeat(64) })).resolves.toBeUndefined();
    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);

    const claim = await store.claimExport(value);
    expect(claim).toEqual({ token: "1".repeat(64) });
    await expect(store.releaseExport(value, { token: "2".repeat(64) })).resolves.toBeUndefined();
    await expect(store.claimExport(value)).resolves.toBeNull();
    await store.releaseExport(value, claim!);
    await expect(store.claimExport(value)).resolves.toEqual(claim);
    await store.releaseExport(value, claim!);
  });

  it("rejects claim authority drift during recovery", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "3".repeat(64),
      isProcessAlive: () => false,
    });
    const claim = await store.claimExport(value);
    expect(claim).not.toBeNull();
    await expect(store.clearStaleExportClaim({ ...value, descriptor_digest: `sha256:${"8".repeat(64)}` }))
      .rejects.toThrow("Evidence-volume export failed");
    await store.releaseExport(value, claim!);
  });

  it("uses process liveness by default and refuses an orphaned recovery tombstone", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory);
    const claim = await store.claimExport(value);
    expect(claim?.token).toMatch(/^[a-f0-9]{64}$/u);
    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);

    const file = await fileWithSuffix(directory, ".claim.json");
    const recovery = `${file}.recovery`;
    await link(file, recovery);
    await unlink(file);
    await expect(store.claimExport(value)).resolves.toBeNull();
    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);
    await unlink(recovery);
  });

  it("fails closed on exact and foreign release tombstones", async () => {
    const exactDirectory = await root();
    const value = admission();
    const exact = await initializeEvidenceExportAuthorityStore(exactDirectory, { createToken: () => "6".repeat(64) });
    const exactClaim = await exact.claimExport(value);
    const exactFile = await fileWithSuffix(exactDirectory, ".claim.json");
    await link(exactFile, `${exactFile}.recovery`);
    await expect(exact.releaseExport(value, exactClaim!)).rejects.toThrow("Evidence-volume export failed");

    const foreignDirectory = await root();
    const foreign = await initializeEvidenceExportAuthorityStore(foreignDirectory, { createToken: () => "7".repeat(64) });
    const foreignClaim = await foreign.claimExport(value);
    const foreignFile = await fileWithSuffix(foreignDirectory, ".claim.json");
    const record = JSON.parse(await readFile(foreignFile, "utf8")) as Record<string, unknown>;
    await writeFile(`${foreignFile}.recovery`, JSON.stringify({ ...record, token: "8".repeat(64) }), { mode: 0o600 });
    await expect(foreign.releaseExport(value, foreignClaim!)).rejects.toThrow("Evidence-volume export failed");
  });

  it("rejects hostile claim-file types, link counts, sizes, and modes", async () => {
    const mutations: ReadonlyArray<(file: string) => Promise<void>> = [
      async (file) => { await unlink(file); await mkdir(file); },
      async (file) => {
        await link(file, `${file}.peer-one`);
        await link(file, `${file}.peer-two`);
        await link(file, `${file}.peer-three`);
      },
      async (file) => { await truncate(file, 65_537); },
      async (file) => { await chmod(file, 0o640); },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const directory = await root();
      const value = admission();
      const store = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "9".repeat(64) });
      await store.claimExport(value);
      await mutate(await fileWithSuffix(directory, ".claim.json"));
      await expect(store.claimExport(value), `hostile claim file ${index + 1}`)
        .rejects.toThrow("Evidence-volume export failed");
    }
  });

  it("rejects malformed and noncanonical persisted claim records", async () => {
    const mutations: ReadonlyArray<(record: Record<string, unknown>) => unknown> = [
      () => null,
      () => [],
      (record) => ({ ...record, unexpected: true }),
      (record) => ({ ...record, version: "spawnfile.target-evidence-export.private.v2" }),
      (record) => ({ ...record, authority: null }),
      (record) => ({ ...record, authority: "bad" }),
      (record) => ({ ...record, generation: null }),
      (record) => ({ ...record, generation: "bad" }),
      (record) => ({ ...record, owner_pid: null }),
      (record) => ({ ...record, owner_pid: 0 }),
      (record) => ({ ...record, owner_pid: 1.5 }),
      (record) => ({ ...record, token: null }),
      (record) => ({ ...record, token: "bad" }),
    ];

    for (const [index, mutate] of mutations.entries()) {
      const directory = await root();
      const value = admission();
      const store = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "4".repeat(64) });
      await store.claimExport(value);
      const file = await fileWithSuffix(directory, ".claim.json");
      const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify(mutate(record)), "utf8");
      await expect(store.claimExport(value), `malformed claim ${index + 1}`)
        .rejects.toThrow("Evidence-volume export failed");
    }

    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "5".repeat(64) });
    await store.claimExport(value);
    const file = await fileWithSuffix(directory, ".claim.json");
    await writeFile(file, `${await readFile(file, "utf8")}\n`, "utf8");
    await expect(store.claimExport(value)).rejects.toThrow("Evidence-volume export failed");
  });
});
