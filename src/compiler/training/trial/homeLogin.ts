import { DAIMON_ORGANIZATION_UID } from "../../../runtime/daimon/runtimeIdentity.js";
import type { TrialDocker } from "./docker.js";

/**
 * The login files an engine with a volume-held login keeps in its runtime home,
 * relative to that home. AGY's OAuth token (which AGY rewrites when it
 * refreshes), its installation id and its onboarded project: nothing else, so
 * no conversation, history or knowledge ever passes between trials.
 */
export const HOME_LOGIN_FILES: Readonly<Record<string, readonly string[]>> = {
  agy: [
    ".gemini/antigravity-cli/antigravity-oauth-token",
    ".gemini/antigravity-cli/installation_id",
    ".gemini/antigravity-cli/cache/default_project_id.txt",
    ".gemini/antigravity-cli/cache/onboarding.json"
  ]
};

/** One organization's runtime home and the profile volume its login files persist in. */
export interface HomeLogin {
  /** The organization's own runtime home volume and where it is mounted. */
  homeVolume: string;
  homeMountPath: string;
  /** The profile's volume holding only the login files. */
  loginVolume: string;
  files: readonly string[];
}

const LOGIN_ROOT = "/spawnfile-home-login";

/**
 * Copies each listed file that exists under `from` to `to`, as the
 * organization uid: regular single-link files only, no link anywhere on either
 * path, written beside the target and renamed over it, identical files left
 * alone. Started as root only to hand the destination root to the uid; the
 * bytes are never printed.
 */
export const HOME_LOGIN_PROGRAM = [
  "const fs = require('node:fs'), path = require('node:path'), { constants } = fs;",
  "const [uidText, from, to, ...files] = process.argv.slice(1); const uid = Number(uidText);",
  "const fail = (message) => { console.error(message); process.exit(3); };",
  "if (process.getuid() === 0) {",
  "  const root = fs.lstatSync(to); if (!root.isDirectory()) fail('login destination is not a directory');",
  "  if (root.uid !== uid || (root.mode & 0o777) !== 0o700) { fs.chmodSync(to, 0o700); fs.chownSync(to, uid, uid); }",
  "  process.setgroups([]); process.setgid(uid); process.setuid(uid);",
  "}",
  "const walk = (root, segments, create) => { let current = root; for (const segment of segments) { current = path.join(current, segment);",
  "  let entry; try { entry = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) return null; fs.mkdirSync(current, { mode: 0o700 }); entry = fs.lstatSync(current); }",
  "  if (!entry.isDirectory()) fail('login directory is not a directory'); } return current; };",
  "for (const file of files) {",
  "  const segments = file.split('/'); if (path.isAbsolute(file) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) fail('invalid login file path');",
  "  if (walk(from, segments.slice(0, -1), false) === null) continue;",
  "  let fd; try { fd = fs.openSync(path.join(from, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if (error.code === 'ENOENT') continue; fail('login file is unreadable or a link'); }",
  "  const entry = fs.fstatSync(fd); if (!entry.isFile() || entry.nlink !== 1) fail('login file is not a regular file');",
  "  const bytes = fs.readFileSync(fd); fs.closeSync(fd); const mode = entry.mode & 0o777;",
  "  const directory = walk(to, segments.slice(0, -1), true), target = path.join(directory, segments.at(-1));",
  "  let current = null; try { const existing = fs.lstatSync(target); if (!existing.isFile()) fail('login target is not a regular file'); current = fs.readFileSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
  "  if (current !== null && current.equals(bytes) && (fs.lstatSync(target).mode & 0o777) === mode) { bytes.fill(0); current.fill(0); continue; }",
  "  current?.fill(0); const temporary = `${target}.spawnfile-${process.pid}`;",
  "  const out = fs.openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);",
  "  let offset = 0; while (offset < bytes.length) offset += fs.writeSync(out, bytes, offset, bytes.length - offset, offset);",
  "  bytes.fill(0); fs.fchmodSync(out, mode); fs.fsyncSync(out); fs.closeSync(out); fs.renameSync(temporary, target);",
  "  const parent = fs.openSync(directory, constants.O_RDONLY); fs.fsyncSync(parent); fs.closeSync(parent);",
  "}"
].join("\n");

const copy = (docker: TrialDocker, image: string, login: HomeLogin, from: string, to: string): Promise<string> => docker([
  "run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL",
  "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "SETUID", "--cap-add", "SETGID",
  "--security-opt", "no-new-privileges", "--entrypoint", "node",
  "--mount", `type=volume,source=${login.loginVolume},target=${LOGIN_ROOT}`,
  // Mounted where the organization mounts it, so a fresh home gets the image's own preimage first.
  "--mount", `type=volume,source=${login.homeVolume},target=${login.homeMountPath}`,
  image, "-e", HOME_LOGIN_PROGRAM, String(DAIMON_ORGANIZATION_UID), from, to, ...login.files
]);

/** Seeds the profile's login files into the organization's fresh runtime home, before it boots. */
export const seedHomeLogin = (docker: TrialDocker, image: string, login: HomeLogin): Promise<string> =>
  copy(docker, image, login, LOGIN_ROOT, login.homeMountPath);

/** Writes the login files the engine wrote or rewrote (a refreshed token) back to the profile, after the container stops. */
export const saveHomeLogin = (docker: TrialDocker, image: string, login: HomeLogin): Promise<string> =>
  copy(docker, image, login, login.homeMountPath, LOGIN_ROOT);
