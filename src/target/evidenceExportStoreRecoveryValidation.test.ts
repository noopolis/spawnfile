import { chmod, link, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import {
  EVIDENCE_EXPORT_HELPER_CONTRACT,
  createEvidenceExportHelper,
  parseEvidenceVolumeAuthority,
} from "./evidenceExportProvider.js";
import { initializeEvidenceExportAuthorityStore, type EvidenceExportAdmission } from "./evidenceExportStore.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-export-recovery-validation-")));
  roots.push(value);
  return value;
};
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

const admission = (): EvidenceExportAdmission => {
  const selected = parseOpaqueTargetHandle("opaque_dddddddddddddddd");
  const volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee"), requestDigest: `sha256:${"f".repeat(64)}`, runId: "run-one", selectedTargetHandle: selected });
  return {
    descriptor_digest: `sha256:${"a".repeat(64)}`,
    evidence_volume: parseEvidenceVolumeAuthority({ labels: volume.labels, name: volume.name, resultHandle: volume.resultHandle }),
    helper: createEvidenceExportHelper({ artifactManifestDigest: `sha256:${"b".repeat(64)}`, imageDigest: `sha256:${"c".repeat(64)}`, imageReference: `registry.example/export@sha256:${"c".repeat(64)}`, resultHandle: parseOpaqueTargetHandle("opaque_bbbbbbbbbbbbbbbb") }),
    helper_contract: EVIDENCE_EXPORT_HELPER_CONTRACT,
    operation_handle: parseOpaqueTargetHandle("opaque_cccccccccccccccc"),
    request_digest: `sha256:${"d".repeat(64)}`,
    run_id: "run-one",
    selected_target: { fingerprint: `sha256:${"e".repeat(32)}`, handle: selected },
    version: "spawnfile.target-evidence-export.private.v1",
  };
};
const fileWithSuffix = async (directory: string, suffix: string): Promise<string> => {
  const found = (await readdir(directory)).find((entry) => entry.endsWith(suffix));
  if (!found) throw new Error(`missing ${suffix}`);
  return path.join(directory, found);
};
const claimPaths = async (directory: string): Promise<{ readonly final: string; readonly pending: string; readonly recovery: string }> => {
  const pending = await fileWithSuffix(directory, ".claim.json.pending");
  const final = pending.slice(0, -".pending".length);
  return { final, pending, recovery: `${final}.recovery` };
};

describe("evidence export claim recovery validation", () => {
  it("abandons its exact pending generation when recovery wins after staging", async () => {
    const directory = await root();
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "a".repeat(64),
      afterClaimPendingCreated: async () => {
        const paths = await claimPaths(directory);
        await link(paths.pending, paths.recovery);
      },
    });

    await expect(store.claimExport(admission())).resolves.toBeNull();
    await expect(fileWithSuffix(directory, ".claim.json.pending")).rejects.toThrow();
    expect(await fileWithSuffix(directory, ".claim.json.recovery")).toContain(".claim.json.recovery");
  });

  it("converges when an exact concurrent publisher links the final first", async () => {
    const directory = await root();
    const value = admission();
    const token = "b".repeat(64);
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => token,
      afterClaimPendingCreated: async () => {
        const paths = await claimPaths(directory);
        await link(paths.pending, paths.final);
      },
    });

    await expect(store.claimExport(value)).resolves.toBeNull();
    await store.releaseExport(value, { token });
  });

  it("uses the persisted owner PID to recover a dead process by default", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "c".repeat(64) });
    await store.claimExport(value);
    const file = await fileWithSuffix(directory, ".claim.json");
    const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...record, owner_pid: 2_147_483_647 }), "utf8");

    await expect(store.clearStaleExportClaim(value)).resolves.toBe(true);
  });

  it("does not unlink a replacement generation observed during release", async () => {
    const directory = await root();
    const value = admission();
    let replaced = false;
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "d".repeat(64),
      afterReleaseClaimObserved: async () => {
        if (replaced) return;
        replaced = true;
        const file = await fileWithSuffix(directory, ".claim.json");
        const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        await unlink(file);
        await writeFile(file, JSON.stringify({ ...record, token: "e".repeat(64) }), { mode: 0o600 });
      },
    });
    const claim = await store.claimExport(value);

    await expect(store.releaseExport(value, claim!)).resolves.toBeUndefined();
    await expect(store.claimExport(value)).resolves.toBeNull();
    await store.releaseExport(value, { token: "e".repeat(64) });
  });

  it("reports incomplete when a stale target disappears before recovery links it", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "f".repeat(64),
      isProcessAlive: () => false,
      afterStaleClaimObserved: async () => { await unlink(await fileWithSuffix(directory, ".claim.json")); },
    });
    await store.claimExport(value);

    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);
  });

  it("does not clear a replacement generation installed before recovery links it", async () => {
    const directory = await root();
    const value = admission();
    let replaced = false;
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "1".repeat(64),
      isProcessAlive: () => false,
      afterStaleClaimObserved: async () => {
        if (replaced) return;
        replaced = true;
        const file = await fileWithSuffix(directory, ".claim.json");
        const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        await unlink(file);
        await writeFile(file, JSON.stringify({ ...record, token: "2".repeat(64) }), { mode: 0o600 });
      },
    });
    await store.claimExport(value);

    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);
    const owner = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "3".repeat(64) });
    await owner.releaseExport(value, { token: "2".repeat(64) });
  });

  it("keeps recovery incomplete when the target disappears after pinning", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "4".repeat(64),
      isProcessAlive: () => false,
      afterRecoveryTombstoneLinked: async () => { await unlink(await fileWithSuffix(directory, ".claim.json")); },
    });
    await store.claimExport(value);

    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);
  });

  it("loses the recovery election when another recovery link appears after observation", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "5".repeat(64),
      isProcessAlive: () => false,
      afterStaleClaimObserved: async () => {
        const file = await fileWithSuffix(directory, ".claim.json");
        await link(file, `${file}.recovery`);
      },
    });
    await store.claimExport(value);

    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);
  });

  it("stops recovery if the pinned owner becomes live", async () => {
    const directory = await root();
    const value = admission();
    let livenessChecks = 0;
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "6".repeat(64),
      isProcessAlive: () => { livenessChecks += 1; return livenessChecks > 1; },
    });
    const claim = await store.claimExport(value);

    await expect(store.clearStaleExportClaim(value)).resolves.toBe(false);
    await store.releaseExport(value, claim!);
  });

  it("revalidates every claim pathname after the pinned-owner liveness check", async () => {
    const scenarios = ["final-absent", "final-replaced", "pending-replaced", "pin-absent"] as const;
    for (const [position, scenario] of scenarios.entries()) {
      const directory = await root();
      const value = admission();
      let file = "";
      let livenessChecks = 0;
      const store = await initializeEvidenceExportAuthorityStore(directory, {
        createToken: () => ["7", "8", "9", "a"][position]!.repeat(64),
        isProcessAlive: () => {
          livenessChecks += 1;
          if (livenessChecks !== 2) return false;
          if (scenario === "final-absent") unlinkSync(file);
          if (scenario === "pin-absent") unlinkSync(`${file}.recovery`);
          if (scenario === "final-replaced" || scenario === "pending-replaced") {
            const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
            const destination = scenario === "final-replaced" ? file : `${file}.pending`;
            if (scenario === "final-replaced") unlinkSync(file);
            writeFileSync(destination, JSON.stringify({ ...record, token: "f".repeat(64) }), { mode: 0o600 });
          }
          return false;
        },
      });
      await store.claimExport(value);
      file = await fileWithSuffix(directory, ".claim.json");

      await expect(store.clearStaleExportClaim(value), scenario).resolves.toBe(false);
    }
  });

  it("rejects split final and pending claim generations", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, { createToken: () => "b".repeat(64) });
    await store.claimExport(value);
    const file = await fileWithSuffix(directory, ".claim.json");
    const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(`${file}.pending`, JSON.stringify({ ...record, token: "c".repeat(64) }), { mode: 0o600 });

    await expect(store.claimExport(value)).rejects.toThrow("Evidence-volume export failed");
  });

  it("fails closed if a pinned recovery generation vanishes or changes before removal", async () => {
    for (const scenario of ["absent", "replaced"] as const) {
      const directory = await root();
      const value = admission();
      let file = "";
      let livenessChecks = 0;
      const store = await initializeEvidenceExportAuthorityStore(directory, {
        createToken: () => "d".repeat(64),
        isProcessAlive: () => {
          livenessChecks += 1;
          if (livenessChecks !== 2) return false;
          const recovery = `${file}.recovery`;
          if (scenario === "absent") unlinkSync(recovery);
          else {
            const record = JSON.parse(readFileSync(recovery, "utf8")) as Record<string, unknown>;
            unlinkSync(recovery);
            writeFileSync(recovery, JSON.stringify({ ...record, token: "e".repeat(64) }), { mode: 0o600 });
          }
          return true;
        },
      });
      await store.claimExport(value);
      file = await fileWithSuffix(directory, ".claim.json");

      await expect(store.clearStaleExportClaim(value), scenario).rejects.toThrow("Evidence-volume export failed");
    }
  });

  it("rejects filesystem policy denial while publishing a recovery pin", async () => {
    const directory = await root();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory, {
      createToken: () => "f".repeat(64),
      isProcessAlive: () => false,
      afterStaleClaimObserved: async () => { await chmod(directory, 0o500); },
    });
    await store.claimExport(value);
    try {
      await expect(store.clearStaleExportClaim(value)).rejects.toThrow("Evidence-volume export failed");
    } finally {
      await chmod(directory, 0o700);
    }
  });
});
