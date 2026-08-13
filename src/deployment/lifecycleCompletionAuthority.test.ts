import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claimLifecycleInvocation,
  claimLifecycleRecovery,
  completeLifecycleInvocation,
  lookupLifecycleCompletion,
  markLifecycleAmbiguous,
  type LifecycleInvocation,
} from "./lifecycleCompletion.js";
import { canonicalLifecycleJson } from "./lifecycleCompletionContracts.js";

const priorHome = process.env.SPAWNFILE_HOME;
let home = "";
const invocation = (): LifecycleInvocation => ({
  correlation: { deployment: "default" },
  id: `lci_${"z".repeat(16)}`,
  operation: "down",
  request_policy: { force: false, remove_volumes: false },
  version: "spawnfile.lifecycle-invocation.v1",
});
const outcome = JSON.stringify(
  {
    deployment: "default",
    errors: [],
    retained_volumes: [],
    units_stopped: [],
    version: "spawnfile.down-receipt.v1",
  },
  null,
  2,
);
const killRecordedOwner = async (
  kind: "admission" | "recovery",
): Promise<void> => {
  const file = path.join(
    home,
    "lifecycle-completions",
    `${invocation().id}.${kind}`,
  );
  const record = JSON.parse(await readFile(file, "utf8")) as {
    owner: { lease_expires_at: number; pid: number };
  };
  record.owner.lease_expires_at = 1;
  await writeFile(file, `${canonicalLifecycleJson(record)}\n`, "utf8");
};
const claimRecoveryOwner = async () => {
  await killRecordedOwner("admission");
  const recovery = await claimLifecycleRecovery(invocation());
  if (recovery.status !== "owner") throw new Error("expected recovery owner");
  return recovery.capability;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-owner-authority-"));
  process.env.SPAWNFILE_HOME = home;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = priorHome;
  await rm(home, { force: true, recursive: true });
});

describe("lifecycle owner authority", () => {
  it("rejects missing and forged owner capabilities", async () => {
    const claim = await claimLifecycleInvocation(invocation());
    if (claim.status !== "owner") throw new Error("expected owner");
    await expect(
      completeLifecycleInvocation(invocation(), outcome, undefined as never),
    ).rejects.toThrow(/invalid owner capability/);
    await expect(
      completeLifecycleInvocation(invocation(), outcome, {
        epoch: "00000000-0000-4000-8000-000000000000",
        role: "initial",
      }),
    ).rejects.toThrow(/invalid owner capability/);
    await expect(
      lookupLifecycleCompletion(invocation().id),
    ).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("makes an initial capability stale after a recovery claim", async () => {
    const initial = await claimLifecycleInvocation(invocation());
    if (initial.status !== "owner") throw new Error("expected owner");
    await killRecordedOwner("admission");
    const recovery = await claimLifecycleRecovery(invocation());
    if (recovery.status !== "owner") throw new Error("expected recovery owner");
    await expect(
      completeLifecycleInvocation(invocation(), outcome, initial.capability),
    ).rejects.toThrow(/invalid owner capability/);
    await expect(
      completeLifecycleInvocation(invocation(), outcome, {
        ...recovery.capability,
        role: "initial",
      }),
    ).rejects.toThrow(/invalid owner capability/);
    await expect(
      completeLifecycleInvocation(invocation(), outcome, recovery.capability),
    ).resolves.toMatchObject({ outcome_bytes: outcome });
    expect(
      JSON.stringify(await lookupLifecycleCompletion(invocation().id)),
    ).not.toContain(recovery.capability.epoch);
  });

  it("publishes one immutable completed-or-ambiguous terminal decision", async () => {
    await claimLifecycleInvocation(invocation());
    const capability = await claimRecoveryOwner();
    const decisions = await Promise.allSettled([
      completeLifecycleInvocation(invocation(), outcome, capability),
      markLifecycleAmbiguous(
        invocation(),
        "reconciliation_ambiguous",
        capability,
      ),
    ]);
    expect(
      decisions.filter((decision) => decision.status === "fulfilled"),
    ).toHaveLength(1);
    expect(["ambiguous", "completed"]).toContain(
      (await lookupLifecycleCompletion(invocation().id)).status,
    );
  });

  it("reads a dead recovery owner as terminal ambiguous", async () => {
    await claimLifecycleInvocation(invocation());
    await claimRecoveryOwner();
    await killRecordedOwner("recovery");
    await expect(claimLifecycleRecovery(invocation())).resolves.toMatchObject({
      status: "ambiguous",
    });
    await expect(
      readFile(
        path.join(
          home,
          "lifecycle-completions",
          `${invocation().id}.completion`,
        ),
        "utf8",
      ),
    ).resolves.toContain('"status":"ambiguous"');
    await expect(
      lookupLifecycleCompletion(invocation().id),
    ).resolves.toMatchObject({
      reason_code: "recovery_owner_died",
      status: "ambiguous",
    });
  });

  it("elects exactly one recovery owner and treats the others as pending", async () => {
    await claimLifecycleInvocation(invocation());
    await killRecordedOwner("admission");
    const claims = await Promise.all([
      claimLifecycleRecovery(invocation()),
      claimLifecycleRecovery(invocation()),
      claimLifecycleRecovery(invocation()),
    ]);
    expect(claims.filter((claim) => claim.status === "owner")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "pending")).toHaveLength(2);
  });
});
