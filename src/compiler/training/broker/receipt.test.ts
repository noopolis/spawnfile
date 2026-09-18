import { describe, expect, it } from "vitest";

import { trainingBrokerTmpfsTargets } from "../container/security.js";
import { buildTrainingSlotReceipt, resolveBackingFilesystem, resolveTrainingCanaries } from "./receipt.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import {
  TRAINING_BOOTSTRAP_MOUNT,
  TRAINING_HOST_BIND_DENY_PATHS,
  TRAINING_REALM_MOUNT,
  TRAINING_RUN_ROOT,
  TRAINING_SEALED_DENY_PATHS,
  TRAINING_SEALED_INPUTS_ROOT
} from "./paths.js";

const digest = (fill: string) => fill.repeat(64).slice(0, 64);
const nonce = digest("a");
const canary = (target: string) => ({ path: target, method: "sandboxed-read" as const, result: "denied" as const });

const receipt = (overrides: Partial<Parameters<typeof buildTrainingSlotReceipt>[0]> = {}) => buildTrainingSlotReceipt({
  slot: 0, workerUid: 2200, generation: 7, nonce, projectionSha256: digest("b"), sandboxProfileSha256: digest("c"),
  seccompProfileSha256: digest("d"), grokExecutableSha256: digest("e"), canaries: [canary("/run/paideia/context.json")],
  createdAt: new Date("2026-09-17T12:00:00.000Z"), ...overrides
});

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

/**
 * The real v3 deny list, not a hand-picked pair. Every test below drives
 * `resolveTrainingCanaries` with `registration.denyPaths` and the real
 * `TRAINING_HOST_BIND_DENY_PATHS` / `TRAINING_SEALED_DENY_PATHS`, because the
 * defect these cover was invisible to a suite that passed `hostBindPaths: []`:
 * with the real constants the documented `refuse` default could not succeed on
 * any host at all, and `profile-only` silently certified the sealed datasets on
 * a boundary the subject can lift from inside its own namespace.
 */
const denyPaths = (): readonly string[] =>
  resolveTrainingGrokRegistration({ agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low" }).denyPaths;

/**
 * `/proc/self/mountinfo` as the v3 launch actually produces it: an overlay
 * image root, one tmpfs per declared target, the realm volume, and the host
 * binds on whatever the daemon's filesystem is. `/run/training/inputs` is
 * deliberately *not* a mount — the launch binds each dataset at
 * `/run/training/inputs/<id>`, so the sealed root is their parent on the
 * read-only image root.
 */
const mountinfoFor = (bindFstype: string, sealedRootFstype?: string): string => [
  "21 20 0:20 / / rw,relatime - overlay overlay rw",
  ...trainingBrokerTmpfsTargets().map((entry, index) => `${30 + index} 21 0:${60 + index} / ${entry.path} rw,relatime - tmpfs tmpfs rw`),
  `90 21 0:90 / ${TRAINING_RUN_ROOT} rw,relatime - ${bindFstype} docker rw`,
  `91 21 0:91 / ${TRAINING_SEALED_INPUTS_ROOT}/project ro,relatime - ${bindFstype} docker ro`,
  `92 21 0:92 / ${TRAINING_BOOTSTRAP_MOUNT} ro,relatime - ${bindFstype} docker ro`,
  `93 21 0:93 / ${TRAINING_REALM_MOUNT} rw,relatime - ext4 /dev/vda1 rw`,
  ...sealedRootFstype === undefined ? [] : [`94 21 0:94 / ${TRAINING_SEALED_INPUTS_ROOT} ro,relatime - ${sealedRootFstype} docker ro`]
].join("\n");

const canaryOptions = (overrides: Partial<Parameters<typeof resolveTrainingCanaries>[0]> = {}) => ({
  denyPaths: denyPaths(), hostBindPaths: TRAINING_HOST_BIND_DENY_PATHS, sealedPaths: TRAINING_SEALED_DENY_PATHS,
  mountinfo: mountinfoFor("ext4"), unenforcedBindPolicy: "refuse" as const,
  probe: async () => true, log: () => undefined, ...overrides
});

describe("training slot canaries", () => {
  it("lets the documented refuse default succeed over the real deny list when the daemon's filesystem enforces ownership", async () => {
    const probed: string[] = [];
    const canaries = await resolveTrainingCanaries(canaryOptions({
      probe: async (target: string) => { probed.push(target); return true; }
    }));
    expect(canaries.map((entry) => entry.path)).toEqual([...denyPaths()]);
    // The whole point: nothing was waived, so every deny entry — the two host binds included — was probed.
    expect(probed).toEqual([...denyPaths()]);
    expect(probed).toContain(TRAINING_RUN_ROOT);
    expect(probed).toContain(TRAINING_SEALED_INPUTS_ROOT);
  });

  it("probes a host bind on an ownership-enforcing filesystem instead of waiving it", async () => {
    await expect(resolveTrainingCanaries(canaryOptions({
      probe: async (target: string) => target !== TRAINING_RUN_ROOT
    }))).rejects.toThrow(new RegExp(`${TRAINING_RUN_ROOT} is still readable by the worker uid`, "u"));
  });

  it("refuses under the default when a deny path lands on a filesystem that ignores ownership", async () => {
    await expect(resolveTrainingCanaries(canaryOptions({ mountinfo: mountinfoFor("virtiofs") })))
      .rejects.toThrow(/ignores unix ownership/u);
  });

  it("accepts the run root on the profile's deny entry alone only when the operator declared that, and says so", async () => {
    const lines: string[] = [];
    const canaries = await resolveTrainingCanaries(canaryOptions({
      mountinfo: mountinfoFor("virtiofs"), unenforcedBindPolicy: "profile-only", log: (line: string) => { lines.push(line); }
    }));
    expect(canaries.map((entry) => entry.path)).toEqual([...denyPaths()]);
    expect(lines.join("\n")).toContain(`canary ${TRAINING_RUN_ROOT} certified by the enforced sandbox profile only (a host bind mount on virtiofs`);
  });

  it("never lets any policy waive the sealed inputs root, even when it lands on an unenforced filesystem", async () => {
    for (const unenforcedBindPolicy of ["refuse", "profile-only"] as const) {
      await expect(resolveTrainingCanaries(canaryOptions({
        mountinfo: mountinfoFor("virtiofs", "virtiofs"), unenforcedBindPolicy
      }))).rejects.toThrow(new RegExp(`sealed canary ${TRAINING_SEALED_INPUTS_ROOT} .*no unenforcedBindPolicy waives this`, "su"));
    }
  });

  it("requires the sealed inputs root to be unenterable, not merely unreadable", async () => {
    // A directory the worker cannot `open()` but can still `search` hands over every dataset it can
    // name — `test.paideia.yaml` included — so `read` denial alone must not certify a sealed root.
    await expect(resolveTrainingCanaries(canaryOptions({
      probe: async (_target: string, depth: "read" | "enter") => depth === "read"
    }))).rejects.toThrow(new RegExp(`sealed canary ${TRAINING_SEALED_INPUTS_ROOT} is still reachable`, "u"));
  });

  it("keeps the sealed set inside the real deny list and out of the host-bind waiver list", () => {
    for (const sealed of TRAINING_SEALED_DENY_PATHS) {
      expect(denyPaths()).toContain(sealed);
      expect(TRAINING_HOST_BIND_DENY_PATHS).not.toContain(sealed);
    }
  });

  it("resolves the longest matching mount point", () => {
    expect(resolveBackingFilesystem("/run/training/slot/usage/usage.jsonl", mountinfoFor("virtiofs"))).toBe("tmpfs");
    expect(resolveBackingFilesystem(`${TRAINING_RUN_ROOT}/runs`, mountinfoFor("virtiofs"))).toBe("virtiofs");
    // The sealed root is the datasets' parent on the image root, never a mount of its own.
    expect(resolveBackingFilesystem(TRAINING_SEALED_INPUTS_ROOT, mountinfoFor("virtiofs"))).toBe("overlay");
    // `/etc/daimon-engine-broker` is one of the declared tmpfs targets, so the image root only shows
    // through for a path no mount covers at all.
    expect(resolveBackingFilesystem("/etc/daimon-engine-broker", mountinfoFor("ext4"))).toBe("tmpfs");
    expect(resolveBackingFilesystem("/opt/training/bin/train", mountinfoFor("ext4"))).toBe("overlay");
  });
});
