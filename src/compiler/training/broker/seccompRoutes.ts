import { DAIMON_GROK_SECCOMP_PROFILE_BYTES } from "../../../shared/daimonGrokSeccompProfile.js";

/**
 * The syscalls a worker-uid namespace escape needs before it can even be
 * attempted: a new user namespace, a new mount namespace, and the mount and
 * unmount calls inside them.
 *
 * `clone`/`clone3` are deliberately absent. The pinned profile allows them only
 * under an argument filter, so a static "is it allowed" question has no honest
 * yes/no answer for them, and `unshare` already gates the route.
 */
export const TRAINING_NAMESPACE_ROUTE_SYSCALLS = ["unshare", "mount", "umount2", "setns"] as const;

/**
 * Whether the pinned seccomp profile lets the worker uid attempt a namespace
 * escape at all — an **unconditional** `SCMP_ACT_ALLOW`, with no
 * `includes.caps` (the container drops `CAP_SYS_ADMIN`) and no argument filter.
 *
 * This exists to keep one specific lie out of the slot receipt. When a probe
 * route cannot run, the honest record is *which layer refused it*: a syscall
 * the profile filters is a stronger denial than DAC and must be named as
 * `seccomp`, while the same syscall refused by a profile that allows it came
 * from the kernel or an LSM and must be named `kernel`. Merging the two into
 * "denied" would let a filtered-syscall run read as though DAC had held.
 */
export const pinnedProfileAllowsNamespaceRoutes = (bytes: string = DAIMON_GROK_SECCOMP_PROFILE_BYTES): boolean => {
  const profile = JSON.parse(bytes) as { syscalls?: { names?: string[]; action?: string; includes?: { caps?: string[] }; args?: unknown[] }[] };
  return TRAINING_NAMESPACE_ROUTE_SYSCALLS.every((syscall) => (profile.syscalls ?? []).some((rule) =>
    (rule.names ?? []).includes(syscall) && rule.action === "SCMP_ACT_ALLOW"
    && (rule.includes?.caps ?? []).length === 0 && (rule.args ?? []).length === 0));
};

/**
 * What to blame when the worker uid cannot open the namespace a route needs.
 *
 * Derived, never guessed: seccomp and a DAC/LSM refusal both surface as
 * `EPERM`, so errno cannot tell them apart. The pinned profile can — Spawnfile
 * ships its bytes and the declaration binds their digest.
 */
export const trainingNamespaceDenialMechanism = (bytes?: string): "seccomp" | "kernel" =>
  pinnedProfileAllowsNamespaceRoutes(bytes) ? "kernel" : "seccomp";
