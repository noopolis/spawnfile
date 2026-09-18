import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SpawnfileError } from "../../../shared/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";

/** Filesystems that silently ignore `chown`/`chmod`, so a worker-uid probe over them proves nothing. */
export const UNENFORCED_OWNERSHIP_FILESYSTEMS = ["virtiofs", "9p", "nfs", "nfs4", "cifs", "smb3", "vboxsf", "grpcfuse"] as const;

const isUnenforced = (fstype: string): boolean =>
  (UNENFORCED_OWNERSHIP_FILESYSTEMS as readonly string[]).includes(fstype) || fstype.startsWith("fuse");

/**
 * The filesystem type backing `target`, from the longest mount point that is a
 * prefix of it. `/proc/self/mountinfo` octal-escapes space, tab, newline and
 * backslash in the mount point field, exactly as the durable-mount guard
 * already handles elsewhere in this compiler.
 */
export const resolveBackingFilesystem = (target: string, mountinfo: string): string => {
  let best = "", fstype = "";
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 0 || fields.length < separator + 2) continue;
    const mountPoint = (fields[4] ?? "").replace(/\\(04[0011]|134)/gu, (match) => ({ "\\040": " ", "\\011": "\t", "\\012": "\n", "\\134": "\\" }[match] ?? match));
    if (mountPoint !== "/" && target !== mountPoint && !target.startsWith(`${mountPoint}/`)) continue;
    if (mountPoint.length >= best.length) { best = mountPoint; fstype = fields[separator + 1] ?? ""; }
  }
  return fstype;
};

export interface TrainingCanaryProbe {
  /**
   * Runs one worker-uid attempt and resolves true when it was denied.
   *
   * `read` is an `open()` for reading. `enter` additionally requires that the
   * worker uid cannot *search* the directory, which is the property a sealed
   * root actually needs: its protection is that every dataset read has to
   * traverse it, not that the directory listing itself is unreadable.
   */
  (target: string, depth: "read" | "enter"): Promise<boolean>;
}

export interface TrainingCanaryOptions {
  denyPaths: readonly string[];
  probe: TrainingCanaryProbe;
  mountinfo: string;
  /** Deny entries the launch bound from the host. Diagnostics only: the backing filesystem decides, not this list. */
  hostBindPaths: readonly string[];
  /** Deny entries no policy may waive; each one must be observed unenterable by the worker uid. */
  sealedPaths: readonly string[];
  unenforcedBindPolicy: "refuse" | "profile-only";
  log(line: string): void;
}

/**
 * One denied canary per deny path, or a refusal naming the first path whose
 * denial this container cannot prove.
 *
 * Three cases, in decreasing strength:
 *
 *  - A **sealed** path (the datasets' root) must sit on a filesystem that
 *    enforces unix ownership and must be observed *unenterable* by the worker
 *    uid. `unenforcedBindPolicy` does not reach it: the sandbox profile alone
 *    is a boundary the worker can lift from inside a namespace of its own, and
 *    the held-out test set is the one thing that cannot rest on it.
 *  - Any other path on an ownership-enforcing filesystem — a host bind over
 *    ext4/xfs/btrfs/overlay included — gets a real worker-uid read probe. This
 *    is what makes the documented `refuse` default reachable: a host bind is
 *    only unprovable where the filesystem says so.
 *  - A path on a filesystem that ignores ownership (virtiofs and grpcfuse under
 *    Docker Desktop and Colima, 9p, nfs, cifs, fuse) cannot be probed at all.
 *    `refuse` — the default — fails the recycle and writes no receipt;
 *    `profile-only` accepts the attested deny entry as that path's only
 *    boundary and names every such path in the supervisor log.
 */
export const resolveTrainingCanaries = async (options: TrainingCanaryOptions): Promise<{ path: string; method: "sandboxed-read"; result: "denied" }[]> => {
  const canaries: { path: string; method: "sandboxed-read"; result: "denied" }[] = [];
  for (const target of options.denyPaths) {
    const fstype = resolveBackingFilesystem(target, options.mountinfo);
    const origin = `${options.hostBindPaths.includes(target) ? "a host bind mount on " : ""}${fstype || "an unknown filesystem"}`;
    if (options.sealedPaths.includes(target)) {
      if (isUnenforced(fstype)) {
        throw new SpawnfileError("runtime_error",
          `Grok slot sealed canary ${target} is backed by ${origin}, which ignores unix ownership, so the worker uid's denial cannot be proven; the sealed datasets must sit under a directory on an ownership-enforcing filesystem and no unenforcedBindPolicy waives this`);
      }
      if (!await options.probe(target, "enter")) {
        throw new SpawnfileError("runtime_error", `Grok slot sealed canary ${target} is still reachable by the worker uid`);
      }
    } else if (isUnenforced(fstype)) {
      if (options.unenforcedBindPolicy === "refuse") {
        throw new SpawnfileError("runtime_error",
          `Grok slot canary ${target} is backed by ${origin}, which ignores unix ownership; declare unenforcedBindPolicy "profile-only" to accept the bubblewrap deny list as its only boundary`);
      }
      options.log(`canary ${target} certified by the enforced sandbox profile only (${origin} ignores unix ownership)`);
    } else if (!await options.probe(target, "read")) {
      throw new SpawnfileError("runtime_error", `Grok slot canary ${target} is still readable by the worker uid`);
    }
    canaries.push({ path: target, method: "sandboxed-read", result: "denied" });
  }
  return canaries;
};

export interface TrainingSlotReceiptInput {
  slot: number;
  workerUid: number;
  generation: number;
  nonce: string;
  projectionSha256: string;
  sandboxProfileSha256: string;
  seccompProfileSha256: string;
  grokExecutableSha256: string;
  canaries: readonly { path: string; method: "sandboxed-read"; result: "denied" }[];
  createdAt: Date;
}

/** `noopolis.daimon.grok-slot-preflight.v2`, in the exact member order Daimon's strict schema accepts. */
export const buildTrainingSlotReceipt = (input: TrainingSlotReceiptInput): Record<string, unknown> => {
  if (!/^[a-f0-9]{64}$/u.test(input.nonce)) throw new SpawnfileError("runtime_error", "Grok slot recycle nonce must be 32 random bytes in lowercase hex");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new SpawnfileError("runtime_error", "Grok slot generation must be a positive integer");
  if (input.canaries.length === 0) throw new SpawnfileError("runtime_error", "Grok slot receipt requires at least one denied canary");
  return {
    version: DAIMON_GROK_ENGINE_BROKER.slotPreflightVersion,
    slot: input.slot,
    worker_uid: input.workerUid,
    generation: input.generation,
    nonce: input.nonce,
    projection_sha256: input.projectionSha256,
    sandbox_profile_sha256: input.sandboxProfileSha256,
    seccomp_profile_sha256: input.seccompProfileSha256,
    sandbox_runtime: "bubblewrap",
    grok_executable_sha256: input.grokExecutableSha256,
    canaries: [...input.canaries],
    created_at: `${input.createdAt.toISOString().slice(0, 23)}Z`
  };
};

/** sha256 of the pinned Grok executable the slot's workers exec, refused unless it is a manifest-pinned 1.0.34 build. */
export const readGrokExecutableSha256 = (executable = DAIMON_GROK_ENGINE_BROKER.grokExecutablePath): string => {
  const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const pinned: readonly string[] = [DAIMON_GROK_ENGINE_BROKER.grokCliArtifacts.arm64.sha256, DAIMON_GROK_ENGINE_BROKER.grokCliArtifacts.x64.sha256];
  if (!pinned.includes(digest)) {
    throw new SpawnfileError("runtime_error", `${path.basename(executable)} is not the manifest-pinned Grok ${DAIMON_GROK_ENGINE_BROKER.grokCliVersion} build`);
  }
  return digest;
};
