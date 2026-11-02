import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import { HOME_LOGIN_FILES, HOME_LOGIN_PROGRAM } from "./homeLogin.js";

const run = promisify(execFile);
const TOKEN = HOME_LOGIN_FILES.agy![0]!;
const HOME = "/var/lib/spawnfile/instances/daimon/runtime-homes/subject";

const state = vi.hoisted(() => ({
  root: "", compiled: 0, homes: [] as string[],
  /** What the booted organization saw in its home: enrollment and leftovers from earlier trials. */
  sightings: [] as Array<{ token: string | null; history: boolean }>
}));
vi.mock("./project.js", () => ({ writeTrialProject: async () => "/nonexistent/Spawnfile" }));
vi.mock("../../buildProject.js", () => ({ buildCompiledProject: async () => undefined }));
vi.mock("../../compileProject.js", () => ({
  compileProject: async () => {
    const volume = `trial-home-${state.compiled++}`;
    state.homes.push(volume);
    return { report: { container: {
      runtime_instances: [{ runtime: "daimon", config_path: "/c.json", engine_by_node_id: { "agent:subject": "agy" },
        agent_paths: { "agent:subject": { home_path: HOME } } }],
      persistent_mounts: [{ id: "daimon-agy-runtime-home-subject", mount_path: HOME, volume_name: volume }]
    } } };
  }
}));
vi.mock("../../runProject.js", () => ({
  runDockerContainer: async () => undefined,
  createDockerRunInvocation: async () => ({ args: [], command: "docker", envFilePath: "/nonexistent", supportDirectory: path.join(state.root, "support") })
}));
// The organization: AGY probes its login in the home, works (writes history) and refreshes its token.
vi.mock("../../runProjectLifecycle.js", () => ({
  executeDockerRunWithSupportCleanup: async () => {
    const home = path.join(state.root, "volumes", state.homes.at(-1)!);
    const token = await readFile(path.join(home, ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8").catch(() => null);
    const history = await readFile(path.join(home, ".gemini/antigravity-cli/history.jsonl")).then(() => true, () => false);
    state.sightings.push({ token, history });
    await writeFile(path.join(home, ".gemini/antigravity-cli/history.jsonl"), "trial conversation\n");
    await writeFile(path.join(home, ".gemini/antigravity-cli/antigravity-oauth-token"), `refreshed-${state.sightings.length}`, { mode: 0o600 });
  }
}));

const { prepareTrial } = await import("./boot.js");

/** Docker volumes as local directories; helper containers run the copy program on them for real. */
const docker = async (args: readonly string[]): Promise<string> => {
  const volume = (name: string) => path.join(state.root, "volumes", name);
  if (args[0] === "volume" && args[1] === "rm") { await rm(volume(args[3]!), { recursive: true, force: true }); return ""; }
  if (args[0] === "inspect") return "true 0";
  if (args[0] !== "run") return "";
  const mounts = new Map<string, string>();
  args.forEach((arg, index) => {
    if (args[index - 1] !== "--mount") return;
    const { source, target } = Object.fromEntries(arg.split(",").map((pair) => pair.split("=") as [string, string]));
    mounts.set(target!, volume(source!));
  });
  for (const dir of mounts.values()) await mkdir(dir, { recursive: true });
  const program = args.indexOf("-e");
  const [uid, direction, home, login, ...files] = args.slice(program + 2);
  await run(process.execPath, ["-e", args[program + 1]!, uid!, direction!, mounts.get(home!)!, mounts.get(login!)!, ...files]);
  return "";
};

const profile: ResolvedAuthProfile = {
  authHome: "/nonexistent", env: {}, imports: {}, name: "training", profileDirectory: "/nonexistent", profilePath: "/nonexistent/p.json", version: 1,
  realms: { agy: { realmVolume: "realm", unlockVolume: "unlock", homeVolume: "profile-home" } }
};

beforeEach(async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-home-login-"));
  Object.assign(state, { compiled: 0, homes: [], sightings: [] });
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

const bootOnce = async (trialId: string): Promise<void> => {
  const prepared = await prepareTrial({ agentManifestPath: "/nonexistent/Spawnfile", directory: path.join(state.root, trialId), docker, instructions: "i", trialId,
    control: async () => ({ status: 200, body: "{}" }) });
  const trial = await prepared.boot(null, { realms: profile, readyTimeoutMs: 1_000 });
  await trial.teardown();
};

it("enrolls each fresh home from the profile and keeps the token AGY refreshed, never its history", async () => {
  const login = path.join(state.root, "volumes", "profile-home", ".gemini/antigravity-cli");
  await mkdir(login, { recursive: true });
  await writeFile(path.join(login, "antigravity-oauth-token"), "logged-in", { mode: 0o600 });
  await bootOnce("one");
  await bootOnce("two");
  // Trial two boots on trial one's refreshed token (lost without the copy-back), in a home with no trial-one history.
  expect(state.sightings).toEqual([{ token: "logged-in", history: false }, { token: "refreshed-1", history: false }]);
  expect(await readFile(path.join(state.root, "volumes", "profile-home", TOKEN), "utf8")).toBe("refreshed-2");
  // Only login files ever reach the profile; every trial home is removed with its trial.
  await expect(readFile(path.join(login, "history.jsonl"))).rejects.toThrow();
  expect(state.homes.map((home) => path.join(state.root, "volumes", home))).toHaveLength(2);
  for (const home of state.homes) await expect(readFile(path.join(state.root, "volumes", home, TOKEN))).rejects.toThrow();
});

it("keeps the login files of the throwaway login home on the profile", async () => {
  const prepared = await prepareTrial({ agentManifestPath: "/nonexistent/Spawnfile", directory: path.join(state.root, "login"), docker, instructions: "i", trialId: "login" });
  await mkdir(path.join(state.root, "volumes", state.homes[0]!, ".gemini/antigravity-cli"), { recursive: true });
  await prepared.login(profile);
  expect(await readFile(path.join(state.root, "volumes", "profile-home", TOKEN), "utf8")).toBe("refreshed-1");
  await expect(readFile(path.join(state.root, "volumes", "profile-home", ".gemini/antigravity-cli/history.jsonl"))).rejects.toThrow();
  await expect(readFile(path.join(state.root, "volumes", state.homes[0]!, TOKEN))).rejects.toThrow();
});

it("refuses a linked login file and skips absent ones", async () => {
  const from = path.join(state.root, "from"), to = path.join(state.root, "to");
  await mkdir(path.join(from, ".gemini/antigravity-cli"), { recursive: true });
  await mkdir(to);
  const copy = (...files: string[]) => run(process.execPath, ["-e", HOME_LOGIN_PROGRAM, "2000", "seed", to, from, ...files]);
  await copy(...HOME_LOGIN_FILES.agy!);
  await writeFile(path.join(state.root, "elsewhere"), "x");
  await symlink(path.join(state.root, "elsewhere"), path.join(from, TOKEN));
  await expect(copy(TOKEN)).rejects.toThrow("login file is unreadable or a link");
  await expect(copy("../escape")).rejects.toThrow("invalid login file path");
  await expect(readFile(path.join(to, TOKEN))).rejects.toThrow();
});
