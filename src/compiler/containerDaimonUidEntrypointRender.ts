import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";

export const DAIMON_AUTHORIZED_UID_ENV = "SPAWNFILE_DAIMON_AUTHORIZED_UID";
export const DAIMON_RUNTIME_UID = 1001;
export const DAIMON_UID_ENTRYPOINT_PATH = "/opt/spawnfile/daimon-uid-entrypoint.sh";
export const DAIMON_RUNTIME_HOMES_DIRECTORY = "runtime-homes";

const SPAWNFILE_PRIVATE_STATE_ROOT = "/var/lib/spawnfile";
const DAIMON_AGY_SUBSCRIPTION_REALM_MOUNT_ID = "daimon-agy-subscription-realm";
const DAIMON_AGY_RUNTIME_HOME_MOUNT_ID_PREFIX = "daimon-agy-runtime-home-";

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const nodeSlug = (nodeId: string): string =>
  nodeId.replace(/^agent:/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const opaqueMountTargets = (runtimePlans: RuntimeTargetPlan[]): string[] =>
  [...new Set(runtimePlans
    .filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => [
      ...(plan.opaqueMountTargets ?? []),
      ...Object.entries(plan.engineByNodeId ?? {})
        .filter(([, engine]) => engine === "codex" || engine === "grok")
        .map(([nodeId, engine]) => path.posix.join(
          plan.instancePaths.instanceRoot ?? "", DAIMON_RUNTIME_HOMES_DIRECTORY,
          nodeSlug(nodeId), ".daimon-inbound", `${engine}-auth`
        ))
    ])
    .filter((target) => target.startsWith("/"))
  )].sort();

export const resolveDaimonUidEntrypointStateRoots = (
  runtimePlans: RuntimeTargetPlan[]
): string[] => [
  ...new Set([
    ...runtimePlans.flatMap((plan) => [
      plan.instancePaths.workspacePath,
      ...(plan.instancePaths.homePath ? [plan.instancePaths.homePath] : []),
      ...(plan.runtimeName === "daimon" && plan.instancePaths.instanceRoot
        ? [path.posix.join(plan.instancePaths.instanceRoot, DAIMON_RUNTIME_HOMES_DIRECTORY)]
        : [])
    ])
  ])
].filter((root) => root.startsWith("/")).sort();

const writableStateRoots = (
  runtimePlans: RuntimeTargetPlan[],
  persistentMountPaths: string[]
): string[] => [
  ...new Set([
    ...resolveDaimonUidEntrypointStateRoots(runtimePlans),
    ...persistentMountPaths
  ])
].filter((root) => root.startsWith("/")).sort();

const privateDirectoriesThrough = (target: string): string[] => {
  if (
    target !== SPAWNFILE_PRIVATE_STATE_ROOT &&
    !target.startsWith(`${SPAWNFILE_PRIVATE_STATE_ROOT}/`)
  ) return [];
  const relative = path.posix.relative(SPAWNFILE_PRIVATE_STATE_ROOT, target);
  const segments = relative === "" ? [] : relative.split("/");
  return [
    SPAWNFILE_PRIVATE_STATE_ROOT,
    ...segments.map((_, index) =>
      path.posix.join(SPAWNFILE_PRIVATE_STATE_ROOT, ...segments.slice(0, index + 1))
    )
  ];
};

const privateModeDirectories = (runtimePlans: RuntimeTargetPlan[]): string[] => [
  ...new Set(runtimePlans
    .filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => plan.persistentMounts ?? [])
    .filter((mount) => mount.id === DAIMON_AGY_SUBSCRIPTION_REALM_MOUNT_ID
      || mount.id.startsWith(DAIMON_AGY_RUNTIME_HOME_MOUNT_ID_PREFIX))
    .map((mount) => mount.mount_path)
    .filter((target) => target.startsWith("/")))
].sort();

const moltnetConfigPaths = (
  moltnet: EntrypointOptions["moltnet"]
): string[] => {
  if (!moltnet) return [];
  return [
    ...moltnet.serverPlans.flatMap((plan) =>
      plan.mode === "managed" && plan.configPath ? [plan.configPath] : []
    ),
    ...moltnet.nodePlans.map((plan) => plan.configPath)
  ].filter((configPath) => configPath.startsWith("/")).sort();
};

export interface DaimonUidEntrypointOwnershipPlan {
  privateDirectories: string[];
  privateFiles: string[];
  privateModeDirectories: string[];
  stateRoots: string[];
}

export const resolveDaimonUidEntrypointOwnershipPlan = (
  runtimePlans: RuntimeTargetPlan[],
  persistentMountPaths: string[] = [],
  moltnet?: EntrypointOptions["moltnet"]
): DaimonUidEntrypointOwnershipPlan => {
  const stateRoots = writableStateRoots(runtimePlans, persistentMountPaths);
  const privateFiles = moltnetConfigPaths(moltnet);
  const modeDirectories = privateModeDirectories(runtimePlans);
  const privateDirectories = [
    ...new Set([
      ...stateRoots.flatMap(privateDirectoriesThrough),
      ...privateFiles.flatMap((configPath) =>
        privateDirectoriesThrough(path.posix.dirname(configPath))
      )
    ])
  ].sort();
  return {
    privateDirectories,
    privateFiles,
    privateModeDirectories: modeDirectories,
    stateRoots
  };
};

const renderOwnershipProgram = (
  opaqueTargets: string[],
  privateDirectories: string[],
  privateFiles: string[],
  privateModeDirectories: string[]
): string => [
  "const fs = require('node:fs');",
  "const constants = fs.constants;",
  "const uid = Number(process.argv[2]);",
  "const roots = process.argv.slice(3);",
  `const opaquePaths = new Set(${JSON.stringify(opaqueTargets)});`,
  `const privateDirectories = ${JSON.stringify(privateDirectories)};`,
  `const privateFiles = ${JSON.stringify(privateFiles)};`,
  `const privateModeDirectories = ${JSON.stringify(privateModeDirectories)};`,
  "const fail = (message) => { process.stderr.write(`Daimon ownership guard: ${message}\\n`); process.exit(1); };",
  "if (!Number.isSafeInteger(uid) || uid < 1 || roots.length === 0) fail('invalid compiler-authored roots');",
  "const decodeMountPath = (value) => value.replace(/\\\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));",
  "const mountOptionsFor = (target) => {",
  "  const matches = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\\n').map((line) => line.split(' ')).filter((parts) => parts.length > 5).map((parts) => ({ point: decodeMountPath(parts[4]), options: parts[5].split(',') })).filter((mount) => target === mount.point || target.startsWith(`${mount.point}/`));",
  "  return matches.sort((left, right) => right.point.length - left.point.length)[0]?.options ?? [];",
  "};",
  "const openDirectoryPath = (target) => {",
  "  if (!target.startsWith('/') || target === '/' || target.includes('//') || target.split('/').includes('..')) fail('unsafe compiler-authored root');",
  "  let fd = fs.openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);",
  "  try {",
  "    for (const segment of target.slice(1).split('/')) {",
  "      if (!segment || segment === '.' || segment === '..') fail('unsafe compiler-authored root');",
  "      const next = fs.openSync(`/proc/self/fd/${fd}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);",
  "      fs.closeSync(fd); fd = next;",
  "    }",
  "    const info = fs.fstatSync(fd);",
  "    if (!info.isDirectory()) fail('root is not a directory');",
  "    if (mountOptionsFor(target).includes('ro')) fail('root is read-only');",
  "    return fd;",
  "  } catch (error) { try { fs.closeSync(fd); } catch {} fail('root has a symbolic-link or unavailable path component'); }",
  "};",
  "const openRegularFilePath = (target) => {",
  "  if (!target.startsWith('/') || target === '/' || target.includes('//') || target.split('/').includes('..')) fail('unsafe compiler-authored file');",
  "  let fd = fs.openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);",
  "  try {",
  "    const segments = target.slice(1).split('/');",
  "    for (const [index, segment] of segments.entries()) {",
  "      if (!segment || segment === '.' || segment === '..') fail('unsafe compiler-authored file');",
  "      const isFile = index === segments.length - 1;",
  "      const next = fs.openSync(`/proc/self/fd/${fd}/${segment}`, constants.O_RDONLY | constants.O_NOFOLLOW | (isFile ? 0 : constants.O_DIRECTORY));",
  "      fs.closeSync(fd); fd = next;",
  "    }",
  "    const info = fs.fstatSync(fd);",
  "    if (!info.isFile() || info.nlink !== 1) fail('compiler-authored file is not one regular file');",
  "    if (mountOptionsFor(target).includes('ro')) fail('compiler-authored file is read-only');",
  "    return fd;",
  "  } catch (error) { try { fs.closeSync(fd); } catch {} fail('file has a symbolic-link or unavailable path component'); }",
  "};",
  "const ownTree = (fd, device, currentPath) => {",
  "  const info = fs.fstatSync(fd);",
  "  if (!info.isDirectory() || info.dev !== device) return;",
  "  fs.fchownSync(fd, uid, uid);",
  "  for (const entry of fs.readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true })) {",
  "    const childPath = `${currentPath}/${entry.name}`;",
  "    if (opaquePaths.has(childPath)) continue;",
  "    let child;",
  "    try { child = fs.openSync(`/proc/self/fd/${fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | (entry.isDirectory() ? constants.O_DIRECTORY : 0)); } catch { fail('state tree contains a symbolic link or unavailable entry'); }",
  "    try { const childInfo = fs.fstatSync(child); if (childInfo.dev !== device || mountOptionsFor(childPath).includes('ro')) continue; if (childInfo.isDirectory()) ownTree(child, device, childPath); else if (childInfo.isFile() && childInfo.nlink === 1) fs.fchownSync(child, uid, uid); else if (!childInfo.isFile()) fail('state tree contains an unsupported entry'); } finally { fs.closeSync(child); }",
  "  }",
  "};",
  "const securePrivateDirectory = (fd) => {",
  "  try {",
  "    fs.fchownSync(fd, 0, 0);",
  "    fs.fchmodSync(fd, 0o700);",
  "    fs.fchownSync(fd, uid, uid);",
  "  } catch {",
  "    try { fs.fchownSync(fd, uid, uid); } catch {}",
  "    fail('unable to secure private directory');",
  "  }",
  "  const info = fs.fstatSync(fd);",
  "  if (info.uid !== uid || info.gid !== uid || (info.mode & 0o777) !== 0o700) fail('private directory ownership or mode did not apply');",
  "};",
  "for (const target of privateDirectories) { if (opaquePaths.has(target)) fail('compiler-authored directory overlaps opaque path'); const fd = openDirectoryPath(target); try { fs.fchownSync(fd, uid, uid); } finally { fs.closeSync(fd); } }",
  "for (const target of privateModeDirectories) { if (opaquePaths.has(target)) fail('private directory overlaps opaque path'); const fd = openDirectoryPath(target); try { securePrivateDirectory(fd); } finally { fs.closeSync(fd); } }",
  "for (const target of privateFiles) { if (opaquePaths.has(target)) fail('compiler-authored file overlaps opaque path'); const fd = openRegularFilePath(target); try { fs.fchownSync(fd, uid, uid); } finally { fs.closeSync(fd); } }",
  "for (const root of roots) { if (opaquePaths.has(root)) fail('state root overlaps opaque path'); const fd = openDirectoryPath(root); try { ownTree(fd, fs.fstatSync(fd).dev, root); } finally { fs.closeSync(fd); } }"
].join("\n");

export const renderDaimonUidEntrypoint = (
  runtimePlans: RuntimeTargetPlan[],
  persistentMountPaths: string[] = [],
  moltnet?: EntrypointOptions["moltnet"]
): string => {
  const opaqueTargets = opaqueMountTargets(runtimePlans);
  const daimonPlan = runtimePlans.find((plan) => plan.runtimeName === "daimon");
  const daimonConfigPath = daimonPlan?.instancePaths.configPath;
  const daimonStartPath = daimonPlan
    ? path.posix.join(daimonPlan.runtimeRoot, "daimon-start.sh")
    : "";
  const ownershipPlan = resolveDaimonUidEntrypointOwnershipPlan(
    runtimePlans,
    persistentMountPaths,
    moltnet
  );
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `uid="\${${DAIMON_AUTHORIZED_UID_ENV}:-${DAIMON_RUNTIME_UID}}"`,
    'case "$uid" in ""|*[!0-9]*|0) echo "Daimon authorized UID must be a nonzero integer" >&2; exit 1;; esac',
    'gid="$uid"',
    `runtime_command=(${quote("/opt/spawnfile/entrypoint.sh")})`,
    'if [ "$#" -gt 0 ]; then',
    `  if [ "$#" -ne 5 ] || [ "$1" != auth ] || [ "$2" != agy ] || [ "$3" != login ] || [ "$4" != --config ] || [ "$5" != ${quote(daimonConfigPath ?? "")} ]; then echo "Unsupported Daimon container command" >&2; exit 1; fi`,
    `  runtime_command=(bash ${quote(daimonStartPath)} "$@")`,
    "fi",
    `state_roots=(${ownershipPlan.stateRoots.map(quote).join(" ")})`,
    "node - \"$uid\" \"${state_roots[@]}\" <<'SPAWNFILE_DAIMON_OWNERSHIP'",
    renderOwnershipProgram(
      opaqueTargets,
      ownershipPlan.privateDirectories,
      ownershipPlan.privateFiles,
      ownershipPlan.privateModeDirectories
    ),
    "SPAWNFILE_DAIMON_OWNERSHIP",
    'if ! getent passwd "$uid" >/dev/null; then',
    '  runtime_identity="daimon-$uid"',
    '  runtime_group="$(getent group "$gid" | cut -d: -f1 || true)"',
    '  if [ -z "$runtime_group" ]; then groupadd -K GID_MIN=1 --gid "$gid" "$runtime_identity"; runtime_group="$runtime_identity"; fi',
    '  useradd -K UID_MIN=1 --no-create-home --no-log-init --uid "$uid" --gid "$gid" --home-dir /nonexistent --shell /usr/sbin/nologin "$runtime_identity"',
    'fi',
    'if ! getent passwd "$uid" >/dev/null; then echo "Daimon authorized UID has no local identity" >&2; exit 1; fi',
    "exec setpriv --clear-groups --reuid \"$uid\" --regid \"$gid\" --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu '",
    "  if [ \"$EUID\" -eq 0 ]; then echo \"Daimon UID wrapper left root effective\" >&2; exit 1; fi",
    "  cap_eff=$(sed -n \"s/^CapEff:[[:space:]]*//p\" /proc/self/status)",
    "  if [ \"$cap_eff\" != \"0000000000000000\" ]; then echo \"Daimon UID wrapper retained effective capabilities\" >&2; exit 1; fi",
    "  exec \"$@\"",
    `' bash "\${runtime_command[@]}"`
  ].join("\n") + "\n";
};
