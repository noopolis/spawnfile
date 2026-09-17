import { describe, expect, it } from "vitest";

import { buildTrainingSlotReceipt, resolveBackingFilesystem, resolveTrainingCanaries } from "./receipt.js";

const digest = (fill: string) => fill.repeat(64).slice(0, 64);
const nonce = digest("a");
const canary = (target: string) => ({ path: target, method: "sandboxed-read" as const, result: "denied" as const });

const receipt = (overrides: Partial<Parameters<typeof buildTrainingSlotReceipt>[0]> = {}) => buildTrainingSlotReceipt({
  slot: 0, workerUid: 2200, generation: 7, nonce, projectionSha256: digest("b"), sandboxProfileSha256: digest("c"),
  seccompProfileSha256: digest("d"), grokExecutableSha256: digest("e"), canaries: [canary("/run/paideia/context.json")],
  createdAt: new Date("2026-09-17T12:00:00.000Z"), ...overrides
});

const mountinfo = [
  "21 20 0:20 / / rw,relatime - overlay overlay rw",
  "30 21 0:31 / /run/training/slot rw,relatime - tmpfs tmpfs rw",
  "31 21 0:32 / /run/training/output rw,relatime - virtiofs docker rw"
].join("\n");

describe("training slot preflight receipt v2", () => {
  it("is the exact v2 shape with the caller's nonce and the supervisor's generation", () => {
    expect(receipt()).toEqual({
      version: "noopolis.daimon.grok-slot-preflight.v2", slot: 0, worker_uid: 2200, generation: 7, nonce,
      projection_sha256: digest("b"), sandbox_profile_sha256: digest("c"), seccomp_profile_sha256: digest("d"),
      sandbox_runtime: "bubblewrap", grok_executable_sha256: digest("e"),
      canaries: [canary("/run/paideia/context.json")], created_at: "2026-09-17T12:00:00.000Z"
    });
  });

  it("refuses a generation below one and a nonce that is not 32 hex bytes", () => {
    expect(() => receipt({ generation: 0 })).toThrow(/positive integer/u);
    expect(() => receipt({ nonce: "not-a-nonce" })).toThrow(/lowercase hex/u);
    expect(() => receipt({ nonce: nonce.toUpperCase() })).toThrow(/lowercase hex/u);
  });

  it("refuses a receipt with no canary at all", () => {
    expect(() => receipt({ canaries: [] })).toThrow(/at least one denied canary/u);
  });
});

describe("training slot canaries", () => {
  it("requires a worker-uid denial for every deny path on a filesystem that enforces ownership", async () => {
    const probed: string[] = [];
    const canaries = await resolveTrainingCanaries({
      denyPaths: ["/run/training/slot/turns", "/run/training/slot/usage"], mountinfo, hostBindPaths: [], unenforcedBindPolicy: "refuse",
      probe: async (target) => { probed.push(target); return true; }, log: () => undefined
    });
    expect(probed).toEqual(["/run/training/slot/turns", "/run/training/slot/usage"]);
    expect(canaries).toHaveLength(2);
  });

  it("refuses to certify a path the worker uid can still read", async () => {
    await expect(resolveTrainingCanaries({
      denyPaths: ["/run/training/slot/turns"], mountinfo, hostBindPaths: [], unenforcedBindPolicy: "refuse",
      probe: async () => false, log: () => undefined
    })).rejects.toThrow(/still readable by the worker uid/u);
  });

  it("refuses a declared host bind by default, because its mode is the operator's and not the container's", async () => {
    await expect(resolveTrainingCanaries({
      denyPaths: ["/run/training/inputs"], mountinfo, hostBindPaths: ["/run/training/inputs"], unenforcedBindPolicy: "refuse",
      probe: async () => { throw Error("the probe must never run on a host bind"); }, log: () => undefined
    })).rejects.toThrow(/is a host bind mount/u);
  });

  it("refuses a filesystem that ignores unix ownership by default, even when the launch did not declare it", async () => {
    await expect(resolveTrainingCanaries({
      denyPaths: ["/run/training/output"], mountinfo, hostBindPaths: [], unenforcedBindPolicy: "refuse",
      probe: async () => { throw Error("the probe must never run on an unenforced filesystem"); }, log: () => undefined
    })).rejects.toThrow(/virtiofs, which ignores unix ownership/u);
  });

  it("accepts a host bind on the profile's deny entry alone only when the operator declared that, and says so", async () => {
    const lines: string[] = [];
    const canaries = await resolveTrainingCanaries({
      denyPaths: ["/run/training/output"], mountinfo, hostBindPaths: [], unenforcedBindPolicy: "profile-only",
      probe: async () => false, log: (line) => lines.push(line)
    });
    expect(canaries).toEqual([canary("/run/training/output")]);
    expect(lines[0]).toContain("certified by the enforced sandbox profile only");
  });

  it("resolves the longest matching mount point", () => {
    expect(resolveBackingFilesystem("/run/training/slot/usage/usage.jsonl", mountinfo)).toBe("tmpfs");
    expect(resolveBackingFilesystem("/run/training/output/runs", mountinfo)).toBe("virtiofs");
    expect(resolveBackingFilesystem("/etc/daimon-engine-broker", mountinfo)).toBe("overlay");
  });
});
