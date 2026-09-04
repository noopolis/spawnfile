import { describe, expect, it } from "vitest";

import { OrganizationHandoffAuthorityFailure } from "./organizationHandoffAuthorityFsBudget.js";
import {
  createAuthorityLeafInspector, type AuthorityLeafStat
} from "./organizationHandoffAuthorityFsElection.js";

const enoent = (): NodeJS.ErrnoException =>
  Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const leaf = (overrides: Partial<Record<"dev" | "ino" | "mode" | "nlink" | "size" | "uid", number>> & {
  readonly file?: boolean; readonly symlink?: boolean;
} = {}): AuthorityLeafStat => ({
  dev: overrides.dev ?? 1, ino: overrides.ino ?? 10, mode: overrides.mode ?? 0o600,
  nlink: overrides.nlink ?? 1, size: overrides.size ?? 30_000, uid: overrides.uid ?? 501,
  isFile: () => overrides.file ?? true,
  isSymbolicLink: () => overrides.symlink ?? false
} as unknown as AuthorityLeafStat);

/**
 * Drive the inspector through a scripted sequence of `lstat` outcomes, which is
 * the only way to stage the mid-race interleavings this logic exists to judge.
 */
const scripted = (steps: readonly (AuthorityLeafStat | NodeJS.ErrnoException)[]) => {
  const seen: string[] = [];
  let index = 0;
  const inspector = createAuthorityLeafInspector({
    lstat: async (name) => {
      seen.push(name);
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return step;
    },
    owner: 501
  });
  return { inspector, seen };
};

describe("authority leaf election", () => {
  it("admits a retry for an ordinary single-link leaf", async () => {
    const { inspector } = scripted([leaf({ nlink: 1 })]);
    expect(await inspector.expectedElectionState("record.json")).toBe(true);
  });

  it("reports an absent leaf rather than a verdict", async () => {
    const { inspector } = scripted([enoent()]);
    expect(await inspector.expectedElectionState("record.json")).toBeNull();
  });

  it("admits a retry when an alias holds the other end of the publication", async () => {
    // Leaf at two links, then the final record matching device and inode.
    const { inspector } = scripted([
      leaf({ nlink: 2 }), enoent(), enoent(), leaf({ nlink: 2 })
    ]);
    expect(await inspector.expectedElectionState("record.json.pending")).toBe(true);
  });

  it("reports absence when the winning publisher unlinks the sidecar mid-check", async () => {
    // The exact losing-publisher interleaving: the sidecar is seen at two
    // links; by the time its aliases are scanned the winner has already linked
    // the final record and unlinked this sidecar, so every alias lstat and the
    // rescan miss. Reporting `false` here fails a benign, converging race.
    const { inspector } = scripted([
      leaf({ nlink: 2 }), enoent(), enoent(), leaf({ nlink: 1, ino: 99 }), enoent()
    ]);
    expect(await inspector.expectedElectionState("record.json.pending")).toBeNull();
  });

  it("still fails closed on an unexplained second hard link", async () => {
    const { inspector } = scripted([
      leaf({ nlink: 2 }), enoent(), enoent(), leaf({ nlink: 1, ino: 99 }), leaf({ nlink: 2 })
    ]);
    expect(await inspector.expectedElectionState("record.json.pending")).toBe(false);
  });

  it("scans exactly the leaves that can hold the counterpart", () => {
    const { inspector } = scripted([leaf()]);
    expect(inspector.aliasesOf("record.json")).toEqual(["record.json.pending", "record.json.recovery"]);
    expect(inspector.aliasesOf("record.json.pending"))
      .toEqual(["record.json.pending.pending", "record.json.pending.recovery", "record.json"]);
    expect(inspector.aliasesOf("record.json.recovery"))
      .toEqual(["record.json.recovery.pending", "record.json.recovery.recovery", "record.json"]);
  });

  it("rejects leaves that are not ordinary owned records", async () => {
    for (const bad of [
      leaf({ file: false }), leaf({ symlink: true }), leaf({ nlink: 3 }),
      leaf({ size: 32_769 }), leaf({ mode: 0o640 }), leaf({ uid: 502 })
    ]) {
      const { inspector } = scripted([bad]);
      await expect(inspector.statFile("record.json")).rejects.toThrow("leaf_not_ordinary");
    }
  });

  it("surfaces a non-ENOENT stat error as a diagnosable failure", async () => {
    const { inspector } = scripted([Object.assign(new Error("EIO"), { code: "EIO" })]);
    await expect(inspector.statFile("record.json")).rejects.toBeInstanceOf(OrganizationHandoffAuthorityFailure);
    const { inspector: other } = scripted([Object.assign(new Error("EIO"), { code: "EIO" })]);
    await expect(other.statFile("record.json")).rejects.toThrow("lstat_failed");
  });

  it("treats an absent leaf as absent regardless of ownership checks", async () => {
    const inspector = createAuthorityLeafInspector({ lstat: async () => { throw enoent(); } });
    expect(await inspector.statFile("record.json")).toBeNull();
  });
});
