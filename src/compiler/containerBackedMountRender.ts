/**
 * Fail-closed guard for durable container state.
 *
 * Every path in `container.persistent_mounts[]` is state the compiler expects
 * a host-backed named volume to hold. `spawnfile run`/`spawnfile up` and
 * `spawnfile deploy` mount them; a hand-rolled `docker run` of the same image
 * does not, and nothing in the image declares `VOLUME`, so the container would
 * silently write its whole durable record onto the container's own writable
 * layer and lose it on `docker rm`. That is exactly how a newsroom's message
 * history was destroyed by a routine recreate.
 *
 * These checks make that case loud instead of silent: the entrypoint refuses
 * to start unless each durable path is a real mount point, naming the mount
 * id, the path, and the volume name to attach. `SPAWNFILE_ALLOW_EPHEMERAL_STATE=1`
 * is the deliberate opt-out for throwaway containers.
 *
 * Detection reads `/proc/self/mountinfo` and looks for an EXACT mount point,
 * rather than comparing `stat -c %d` against the parent directory: two nested
 * durable volumes live on the same host filesystem and therefore share a
 * device number, which would make a device comparison report a genuinely
 * backed inner mount as unbacked.
 *
 * The kernel octal-escapes four characters in the mountinfo mount-point field
 * (`show_mountinfo` passes `" \t\n\\"` to `seq_path_root`), so a declared
 * `mount: "/var/lib/my store"` appears there as `/var/lib/my\040store`. The
 * comparison is therefore made against the compiler-escaped form — computed
 * here, where it is exactly testable — while the operator-facing message keeps
 * the real path. Escaping at compile time rather than decoding in shell keeps
 * the check a deterministic string compare with no dependence on how a
 * particular `printf %b` implementation treats `\nnn` vs `\0nnn`. For a path
 * containing none of those four characters both forms are identical.
 */

export const EPHEMERAL_STATE_OPT_OUT_ENV = "SPAWNFILE_ALLOW_EPHEMERAL_STATE";

export interface BackedMountRequirement {
  id: string;
  mount_path: string;
  volume_name: string;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const MOUNTINFO_ESCAPES: Record<string, string> = {
  "\\": "\\134",
  " ": "\\040",
  "\t": "\\011",
  "\n": "\\012"
};

/** The mount-point field exactly as `/proc/self/mountinfo` renders this path. */
export const escapeMountInfoPath = (value: string): string =>
  value.replace(/[\\ \t\n]/gu, (character) => MOUNTINFO_ESCAPES[character]!);

export const createBackedMountShellFunction = (): string[] => [
  "require_backed_mount() {",
  '  local mount_id="$1"',
  // As mountinfo renders it (octal-escaped), for the comparison only.
  '  local mount_field="$2"',
  // The real path, for every operator-facing message.
  '  local mount_target="$3"',
  '  local mount_volume="$4"',
  "  local mount_point",
  `  if [ "\${${EPHEMERAL_STATE_OPT_OUT_ENV}:-}" = "1" ]; then`,
  "    return 0",
  "  fi",
  "  if [ ! -r /proc/self/mountinfo ]; then",
  '    echo "Durable mount $mount_id at $mount_target cannot be verified: /proc/self/mountinfo is unreadable" >&2',
  "    exit 1",
  "  fi",
  "  while read -r _ _ _ _ mount_point _; do",
  '    if [ "$mount_point" = "$mount_field" ]; then',
  "      return 0",
  "    fi",
  "  done < /proc/self/mountinfo",
  '  echo "Durable mount $mount_id is not backed by a volume at $mount_target; this container would lose that state when it is removed." >&2',
  `  echo "Start this image with 'spawnfile run' or 'spawnfile up', or pass: --mount type=volume,source=\$mount_volume,target=\$mount_target" >&2`,
  `  echo "Set ${EPHEMERAL_STATE_OPT_OUT_ENV}=1 to run this container without durable state." >&2`,
  "  exit 1",
  "}"
];

/**
 * One check per durable mount, deduplicated by path and ordered by path so the
 * rendered entrypoint is a deterministic function of the compile plan.
 */
export const createBackedMountChecks = (
  mounts: readonly BackedMountRequirement[]
): string[] => {
  const byPath = new Map<string, BackedMountRequirement>();
  for (const mount of mounts) {
    if (!byPath.has(mount.mount_path)) byPath.set(mount.mount_path, mount);
  }
  return [...byPath.values()]
    .sort((left, right) => left.mount_path.localeCompare(right.mount_path))
    .map((mount) =>
      `require_backed_mount ${shellQuote(mount.id)} ${shellQuote(escapeMountInfoPath(mount.mount_path))} ${shellQuote(mount.mount_path)} ${shellQuote(mount.volume_name)}`
    );
};

/**
 * The full guard — function plus checks — or nothing at all when the compile
 * declares no durable mounts.
 */
export const createBackedMountGuard = (
  mounts: readonly BackedMountRequirement[]
): string[] => {
  const checks = createBackedMountChecks(mounts);
  return checks.length === 0 ? [] : [...createBackedMountShellFunction(), "", ...checks, ""];
};

/**
 * Compile-time operator surface: how many durable mounts this organization
 * requires a launcher to attach.
 */
export const describeBackedMountRequirement = (
  mounts: readonly BackedMountRequirement[]
): string | null => {
  const count = new Set(mounts.map((mount) => mount.mount_path)).size;
  if (count === 0) return null;
  return `${count} durable mount${count === 1 ? "" : "s"} must be attached at start: use 'spawnfile run'/'spawnfile up', or pass matching --mount type=volume args. The entrypoint refuses to start otherwise (set ${EPHEMERAL_STATE_OPT_OUT_ENV}=1 to accept state loss).`;
};
