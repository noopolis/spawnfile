import crypto from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { daimonGrokWorkerSandboxProfileSha256, renderDaimonGrokWorkerSandboxProfile } from "../runtime/daimon/grokWorkerContract.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../runtime/daimon/contractManifest.js";
import { DAIMON_GROK_WORKER_CONFIG_BYTES } from "../runtime/daimon/grokWorkerConfigBytes.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { renderDaimonGrokHostPreflight, renderDaimonGrokWorkerProvisioning } from "./containerDaimonGrokWorkerProvisioning.js";
import { resolveDaimonGrokRegistrations, type DaimonGrokRegistration } from "./containerDaimonGrokWorkerRender.js";

const INSTANCE = "/var/lib/spawnfile/instances/daimon/daimon-organization";
const BROKER = 2100;

type Node = { content: string; gid: number; kind: "dir" | "file" | "link"; mode: number; target?: string; uid: number };

/**
 * Just enough of `node:fs` to run the rendered root program without root — including the one
 * capability the container does NOT grant. `spawnfile up` runs the organization container with
 * `--cap-drop ALL` and adds only CHOWN, DAC_READ_SEARCH, KILL, SETGID, SETPCAP and SETUID, so the
 * rendered program runs as uid 0 WITHOUT CAP_DAC_OVERRIDE and WITHOUT CAP_FOWNER: it may chown
 * anything and traverse anything, but it may only create inside a directory the ordinary mode bits
 * let uid 0 write, and only chmod what it owns. Modelling that here is what makes this harness able
 * to fail on a provisioning step that would exit the real container 1 at start.
 */
const memoryFs = (seed: Record<string, Partial<Node>>) => {
  const nodes = new Map<string, Node>([["/", { content: "", gid: 0, kind: "dir", mode: 0o755, uid: 0 }]]);
  const enoent = (target: string) => Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
  const eacces = (target: string) => Object.assign(new Error(`EACCES: ${target}`), { code: "EACCES" });
  const put = (target: string, node: Partial<Node>) => {
    for (let parent = path.posix.dirname(target); !nodes.has(parent); parent = path.posix.dirname(parent)) {
      nodes.set(parent, { content: "", gid: 0, kind: "dir", mode: 0o755, uid: 0 });
    }
    nodes.set(target, { content: "", gid: 0, kind: "dir", mode: 0o755, uid: 0, ...node });
  };
  for (const [target, node] of Object.entries(seed)) put(target, node);
  const get = (target: string): Node => { const node = nodes.get(target); if (!node) throw enoent(target); return node; };
  const stat = (target: string) => {
    const node = get(target);
    const type = node.kind === "dir" ? 0o040000 : node.kind === "file" ? 0o100000 : 0o120000;
    return { gid: node.gid, isDirectory: () => node.kind === "dir", isFile: () => node.kind === "file", isSymbolicLink: () => node.kind === "link", mode: type | node.mode, nlink: 1, uid: node.uid };
  };
  // uid 0 without CAP_DAC_OVERRIDE: only the owner/group/other write bits that actually apply to it.
  const rootMayWrite = (node: Node) => (node.uid === 0 && (node.mode & 0o200) !== 0)
    || (node.gid === 0 && (node.mode & 0o020) !== 0) || (node.mode & 0o002) !== 0;
  const assertCreatableIn = (target: string) => {
    let parent = path.posix.dirname(target);
    while (!nodes.has(parent) && parent !== "/") parent = path.posix.dirname(parent);
    const node = nodes.get(parent);
    if (node && !rootMayWrite(node)) throw eacces(target);
  };
  const fs = {
    // No CAP_FOWNER: chmod is only permitted on what uid 0 owns, which is why the rendered program
    // chowns a target to root before every chmod and then hands it back.
    chmodSync: (target: string, mode: number) => {
      const node = get(target);
      if (node.uid !== 0) throw Object.assign(new Error(`EPERM: ${target}`), { code: "EPERM" });
      node.mode = mode & 0o7777;
    },
    chownSync: (target: string, uid: number, gid: number) => { const node = get(target); node.uid = uid; node.gid = gid; },
    lstatSync: stat,
    mkdirSync: (target: string, options: { mode?: number; recursive?: boolean } = {}) => {
      if (nodes.has(target)) { if (options.recursive) return; throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); }
      if (!options.recursive) get(path.posix.dirname(target));
      assertCreatableIn(target);
      put(target, { kind: "dir", mode: options.mode ?? 0o755 });
    },
    readFileSync: (target: string) => get(target).content,
    realpathSync: (target: string) => {
      let resolved = "/";
      for (const segment of target.split("/").filter(Boolean)) {
        resolved = path.posix.join(resolved, segment);
        const node = get(resolved);
        if (node.kind === "link") resolved = node.target!;
      }
      return resolved;
    },
    statSync: stat,
    writeFileSync: (target: string, content: string, options: { flag?: string; mode?: number } = {}) => {
      if (options.flag === "wx" && nodes.has(target)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      if (!nodes.has(target)) assertCreatableIn(target);
      put(target, { content: String(content), kind: "file", mode: options.mode ?? 0o644 });
    }
  };
  return { fs, nodes };
};

const plan = (engines: Record<string, string>): RuntimeTargetPlan => ({
  engineByNodeId: engines,
  grokModelByNodeId: Object.fromEntries(Object.entries(engines).filter(([, engine]) => engine === "grok").map(([id]) => [id, { model: "grok-4.6", reasoningEffort: "low" }])),
  instancePaths: { configPath: `${INSTANCE}/daimon/config.json`, instanceRoot: INSTANCE, workspacePath: `${INSTANCE}/workspace` },
  runtimeName: "daimon"
}) as unknown as RuntimeTargetPlan;

const seedFor = (registrations: readonly DaimonGrokRegistration[], omit: string[] = []) => Object.fromEntries([
  ...registrations.map((entry) => [entry.workspace, { kind: "dir" as const }] as const),
  ["/etc/daimon-engine-broker", { kind: "dir" as const, mode: 0o700 }] as const,
  ...registrations.flatMap((entry) => entry.denyPaths)
    .filter((denied) => !denied.startsWith("/var/lib/daimon-workers/") && !(["/run/secrets", "/run/spawnfile", "/run/spawnfile-secrets", "/run/world"] as string[]).includes(denied))
    .map((denied) => [denied, { kind: denied.endsWith("grok-bootstrap-auth") ? "file" as const : "dir" as const, mode: 0o700 }] as const)
].filter(([target]) => !omit.includes(target)));

const run = (registrations: readonly DaimonGrokRegistration[], seed: Record<string, Partial<Node>>, lines = renderDaimonGrokWorkerProvisioning(registrations)) => {
  const memory = memoryFs(seed);
  const secureWorkspace = (): void => undefined;
  const program = new Function("fs", "crypto", "secureWorkspace", "require", lines.join("\n"));
  program(memory.fs, crypto, secureWorkspace, (name: string) => name === "node:path" ? path.posix : undefined);
  return memory.nodes;
};

describe("Grok worker home provisioning", () => {
  const registrations = resolveDaimonGrokRegistrations([plan({ "agent:a": "grok", "agent:b": "grok", "agent:c": "codex" })]);

  it("provisions Daimon's attested layout: sticky root:worker homes and root-owned read-only turn files", () => {
    const nodes = run(registrations, seedFor(registrations));
    for (const entry of registrations) {
      expect(nodes.get(entry.home)).toMatchObject({ gid: BROKER, mode: 0o710, uid: entry.uid });
      for (const directory of [entry.grokHome, `${entry.grokHome}/sessions`]) {
        expect(nodes.get(directory)).toMatchObject({ gid: entry.uid, kind: "dir", mode: 0o1771, uid: 0 });
      }
      expect(nodes.get(`${entry.grokHome}/config.toml`)!.content).toBe(DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.6"].low);
      expect(nodes.get(entry.profilePath)!.content).toBe(entry.profile);
      for (const name of ["config.toml", "sandbox.toml", "trusted_folders.toml", "managed_config.toml", "requirements.toml"]) {
        const file = nodes.get(`${entry.grokHome}/${name}`)!;
        expect(file, name).toMatchObject({ gid: 0, kind: "file", mode: 0o444, uid: 0 });
        // No worker-uid process may write any file that decides a turn, trust included.
        expect(file.mode & 0o222, name).toBe(0);
      }
      for (const name of ["trusted_folders.toml", "managed_config.toml", "requirements.toml"]) expect(nodes.get(`${entry.grokHome}/${name}`)!.content).toBe("");
      expect(nodes.get(entry.eventsPath)).toMatchObject({ gid: BROKER, kind: "file", mode: 0o640, uid: entry.uid });
      expect(nodes.has(`${entry.grokHome}/sandbox-events.jsonl`)).toBe(false);
    }
    const service = JSON.parse(nodes.get("/etc/daimon-engine-broker/service.json")!.content);
    expect(service.version).toBe("noopolis.daimon.engine-broker-service.v2");
    expect(nodes.get("/etc/daimon-engine-broker/service.json")).toMatchObject({ gid: BROKER, mode: 0o440, uid: 0 });
    for (const optional of ["/run/secrets", "/run/spawnfile", "/run/spawnfile-secrets"]) expect(nodes.get(optional)).toMatchObject({ kind: "dir", mode: 0o700, uid: 0 });
  });

  it("provisions the P1b temp and spill contract: private TMPDIR, closed shared temp, setgid spills under a traversable runtime home", () => {
    const runtimeHomes = `${INSTANCE}/runtime-homes`;
    const nodes = run(registrations, { ...seedFor(registrations), [runtimeHomes]: { gid: 2000, kind: "dir", mode: 0o700, uid: 2000 }, "/tmp": { kind: "dir", mode: 0o1777 } });
    for (const shared of ["/tmp", "/var/tmp"]) expect(nodes.get(shared), shared).toMatchObject({ gid: 2000, kind: "dir", mode: 0o1774, uid: 0 });
    // Owner and group survive the traversal fix: root reclaims, modes, and restores (no CAP_FOWNER).
    expect(nodes.get(runtimeHomes)).toMatchObject({ gid: 2000, mode: 0o711, uid: 2000 });
    for (const entry of registrations) {
      expect(entry.privateTmp).toBe(`${entry.home}/tmp`);
      expect(nodes.get(entry.privateTmp)).toMatchObject({ gid: entry.uid, kind: "dir", mode: 0o700, uid: entry.uid });
      expect(nodes.get(entry.runtimeHome)).toMatchObject({ gid: entry.uid, kind: "dir", mode: 0o710, uid: 2000 });
      expect(entry.spillDirectory).toBe(`${entry.runtimeHome}/tool-output`);
      expect(nodes.get(entry.spillDirectory)).toMatchObject({ gid: entry.uid, kind: "dir", mode: 0o2750, uid: 2000 });
      expect(entry.profilePath).toBe(`${entry.home}/.grok/sandbox.toml`);
    }
  });

  /**
   * The container's ownership pass runs before this program and chowns every compiler-authored
   * private directory — each organization runtime home among them — to the organization uid, while
   * the mode stays whatever the image baked. Root is then outside the owner class there, and with no
   * CAP_DAC_OVERRIDE a bare `mkdir` of the spill directory fails EACCES, which exits the container 1
   * at start. Seeded exactly as that pass leaves it, provisioning must still reach the attested
   * layout, so root has to reclaim the home before it creates anything inside.
   */
  it("creates the spill directory in a runtime home the ownership pass already gave to the organization uid", () => {
    const nodes = run(registrations, {
      ...seedFor(registrations),
      [`${INSTANCE}/runtime-homes`]: { gid: 2000, kind: "dir", mode: 0o700, uid: 2000 },
      ...Object.fromEntries(registrations.map((entry) => [entry.runtimeHome, { gid: 2000, kind: "dir" as const, mode: 0o755, uid: 2000 }])),
      "/tmp": { kind: "dir", mode: 0o1777 }
    });
    for (const entry of registrations) {
      expect(nodes.get(entry.spillDirectory), entry.spillDirectory).toMatchObject({ gid: entry.uid, kind: "dir", mode: 0o2750, uid: 2000 });
      expect(nodes.get(entry.runtimeHome), entry.runtimeHome).toMatchObject({ gid: entry.uid, kind: "dir", mode: 0o710, uid: 2000 });
    }
  });

  /**
   * Daimon's `physicalReadiness.ts` refuses a brokered Grok agent whose
   * organization runtime home is not exactly owner = runtime uid, mode 0710
   * (`& 0o7777`, so no setgid or sticky), group = a worker group (gid >= the
   * first worker uid and not the runtime's own gid). A 0700 home is refused too,
   * because the worker could not reach its own spills. This mirrors that rule so
   * a wrong mode or group fails here instead of at container start.
   */
  const assertDaimonRuntimeHomeReadiness = (node: Node | undefined, workerUid: number): void => {
    const home = DAIMON_GROK_ENGINE_BROKER.worker.home.organizationRuntimeHome;
    expect(node?.kind).toBe("dir");
    expect(node!.uid).toBe(2000);
    expect(node!.mode & 0o7777).toBe(home.mode);
    expect(node!.gid).toBeGreaterThanOrEqual(DAIMON_GROK_ENGINE_BROKER.identities.firstWorkerUid);
    expect(node!.gid).not.toBe(2000);
    expect(node!.gid).toBe(workerUid);
  };

  it("provisions the runtime home shape Daimon's engine-aware readiness demands, and keeps everything inside it private but tool-output", () => {
    const withMounts = resolveDaimonGrokRegistrations([{
      ...plan({ "agent:a": "grok", "agent:b": "grok", "agent:c": "codex" }),
      persistentMounts: [
        { id: "tool-state-a", mount_path: `${INSTANCE}/runtime-homes/a/tool-state`, reason: "receipts", volume_name: "a" },
        { id: "engine-home-a", mount_path: `${INSTANCE}/runtime-homes/a/.grok`, reason: "credential home", volume_name: "b" },
        { id: "tool-state-c", mount_path: `${INSTANCE}/runtime-homes/c/tool-state`, reason: "receipts", volume_name: "c" }
      ]
    } as unknown as RuntimeTargetPlan]);
    expect(withMounts[0]!.runtimeHomeMounts).toEqual([`${INSTANCE}/runtime-homes/a/.grok`, `${INSTANCE}/runtime-homes/a/tool-state`]);
    expect(withMounts[1]!.runtimeHomeMounts).toEqual([]);
    const nodes = run(withMounts, {
      ...seedFor(withMounts),
      [`${INSTANCE}/runtime-homes/a/tool-state`]: { gid: 2000, kind: "dir", mode: 0o755, uid: 2000 },
      [`${INSTANCE}/runtime-homes/a/.grok`]: { gid: 2000, kind: "dir", mode: 0o755, uid: 2000 }
    });
    for (const entry of withMounts) {
      assertDaimonRuntimeHomeReadiness(nodes.get(entry.runtimeHome), entry.uid);
      // Only the setgid spill directory is wider than 0700 inside the traversable home.
      for (const [target, node] of nodes) {
        if (!target.startsWith(`${entry.runtimeHome}/`)) continue;
        if (target === entry.spillDirectory) { expect(node.mode & 0o7777).toBe(0o2750); continue; }
        expect(node.mode & 0o7777, target).toBe(0o700);
        expect([node.uid, node.gid], target).toEqual([2000, 2000]);
      }
    }
    // A non-Grok peer's runtime home keeps whatever it had (Daimon still demands 0700 there).
    expect(nodes.get(`${INSTANCE}/runtime-homes/c`)?.mode).toBe(0o700);
    expect(nodes.has(`${INSTANCE}/runtime-homes/c/tool-state`)).toBe(false);
  });

  it("creates a peer resource backing the organization entrypoint only materializes later, but never follows a symlink", () => {
    const withResource = resolveDaimonGrokRegistrations([{
      ...plan({ "agent:a": "grok", "agent:b": "grok" }),
      resources: [{ backingPath: "/var/lib/spawnfile/resources/instances/daimon-organization/b-repo", id: "b-repo", kind: "git", linkPath: `${INSTANCE}/workspace/agents/b/b-repo`, mode: "readonly", mount: "./b-repo", sharing: "agent" }]
    } as unknown as RuntimeTargetPlan]);
    const backing = "/var/lib/spawnfile/resources/instances/daimon-organization/b-repo";
    expect(withResource[0]!.deferredDenyPaths).toEqual([backing]);
    // The engine broker's own placement preflight runs before the organization entrypoint clones or
    // unpacks anything, and refuses a deny target that does not exist — so provisioning has to leave an
    // empty, root-owned one behind rather than skip it.
    const prepared = run(withResource, seedFor(withResource, [backing]));
    expect(prepared.get(backing)).toMatchObject({ kind: "dir", mode: 0o755, uid: 0 });
    // The instance directory it sits in belongs to the organization uid by then — root has to borrow it
    // to create inside, and give it back exactly as it was, or the resource lands unreadable later.
    const instances = "/var/lib/spawnfile/resources/instances/daimon-organization";
    const borrowed = run(withResource, { ...seedFor(withResource, [backing]), [instances]: { gid: 2000, kind: "dir", mode: 0o755, uid: 2000 } });
    expect(borrowed.get(backing)).toMatchObject({ kind: "dir", mode: 0o755, uid: 0 });
    expect(borrowed.get(instances)).toMatchObject({ gid: 2000, mode: 0o755, uid: 2000 });
    expect(() => run(withResource, { ...seedFor(withResource, [backing]), [backing]: { kind: "link", target: "/tmp/elsewhere" }, "/tmp/elsewhere": { kind: "dir" } }))
      .toThrow(/canonical non-symlink/u);
    expect(() => run(withResource, seedFor(withResource, ["/var/lib/spawnfile/daimon/usage"]))).toThrow(/deny path is missing/u);
  });

  it("is restart-idempotent over an already provisioned home", () => {
    const first = run(registrations, seedFor(registrations));
    const reseeded = Object.fromEntries([...first.entries()].filter(([target]) => target !== "/etc/daimon-engine-broker/service.json"));
    expect(() => run(registrations, reseeded)).not.toThrow();
  });

  it("fails closed on a missing or symlinked deny path, or bytes that drifted from their pins", () => {
    const realm = "/var/lib/spawnfile/daimon/grok-subscription-realm";
    expect(() => run(registrations, seedFor(registrations, [realm]))).toThrow(/deny path is missing: \/var\/lib\/spawnfile\/daimon\/grok-subscription-realm/u);
    expect(() => run(registrations, { ...seedFor(registrations), [realm]: { kind: "link", target: "/tmp/elsewhere" }, "/tmp/elsewhere": { kind: "dir" } }))
      .toThrow(/canonical non-symlink/u);
    const workspace = registrations[0]!.workspace;
    expect(() => run(registrations, { ...seedFor(registrations), [workspace]: { kind: "link", target: "/tmp/ws" }, "/tmp/ws": { kind: "dir" } }))
      .toThrow(/canonical non-symlink/u);
    const tampered = registrations.map((entry, index) => index === 0 ? { ...entry, config: entry.config.replace("grok-4.6", "grok-4.5") } : entry);
    expect(() => run(tampered, seedFor(tampered))).toThrow(/do not match their pins/u);
    // Another model's pinned bytes are still refused: the pin is per declared model x effort, not any pin.
    const otherPair = registrations.map((entry, index) => index === 0 ? { ...entry, config: DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.5"].high, configSha256: crypto.createHash("sha256").update(DAIMON_GROK_WORKER_CONFIG_BYTES["grok-4.5"].high).digest("hex") } : entry);
    expect(() => run(otherPair, seedFor(otherPair))).toThrow(/do not match their pins/u);
    const otherEffort = registrations.map((entry, index) => index === 0 ? { ...entry, reasoningEffort: "medium" as const } : entry);
    expect(() => run(otherEffort, seedFor(otherEffort))).toThrow(/do not match their pins/u);
    const unpinned = registrations.map((entry, index) => index === 0 ? { ...entry, denyPaths: [] } : entry);
    expect(() => run(unpinned, seedFor(unpinned))).toThrow(/do not match their pins/u);
    const replaced = run(registrations, seedFor(registrations));
    const reseeded = Object.fromEntries([...replaced.entries()].filter(([target]) => target !== "/etc/daimon-engine-broker/service.json"));
    reseeded[`${registrations[0]!.grokHome}/trusted_folders.toml`] = { ...reseeded[`${registrations[0]!.grokHome}/trusted_folders.toml`], content: "[trusted]\n" };
    expect(() => run(registrations, reseeded)).toThrow(/identity mismatch/u);
  });
});

describe("Grok host user-namespace preflight", () => {
  const preflight = async (restrict: string | null, maxNamespaces: string | null) => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-grok-procsys-"));
    try {
      await mkdir(path.join(root, "kernel")); await mkdir(path.join(root, "user"));
      if (restrict !== null) await writeFile(path.join(root, "kernel", "apparmor_restrict_unprivileged_userns"), `${restrict}\n`);
      if (maxNamespaces !== null) await writeFile(path.join(root, "user", "max_user_namespaces"), `${maxNamespaces}\n`);
      const script = ["set -euo pipefail", ...renderDaimonGrokHostPreflight(root), "echo preflight-ok"].join("\n");
      return spawnSync("bash", ["-c", script], { encoding: "utf8" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  };

  it("refuses to start when the host restricts unprivileged user namespaces, naming the sysctl", async () => {
    const restricted = await preflight("1", "63000");
    expect(restricted.status).toBe(1);
    expect(restricted.stderr).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect((await preflight("0", "0")).stderr).toContain("user.max_user_namespaces is 0");
    expect((await preflight("0", "63000")).stdout).toContain("preflight-ok");
    expect((await preflight(null, null)).stdout).toContain("preflight-ok");
  });
});

describe("Grok deny-path placement", () => {
  const registrations = resolveDaimonGrokRegistrations([plan({ "agent:a": "grok", "agent:b": "grok" })]);

  it("refuses a deny entry under a directory the worker uid cannot search", () => {
    // Grok 1.0.34 materializes every deny target inside bubblewrap as the worker uid, so a private
    // ancestor makes the whole profile unusable — every turn dies with `bwrap: Can't create file at …`.
    const shared = "/var/lib/spawnfile/daimon";
    expect(() => run(registrations, { ...seedFor(registrations), [shared]: { gid: 0, kind: "dir", mode: 0o700, uid: 0 } }))
      .toThrow(/is not placeable: worker uid 2200 cannot search \/var\/lib\/spawnfile\/daimon \(700 0:0\); deny that directory itself instead/u);
    // 0711 — search without read — is exactly what the shared state ancestor is provisioned as, and is enough.
    expect(() => run(registrations, { ...seedFor(registrations), [shared]: { gid: 0, kind: "dir", mode: 0o711, uid: 0 } })).not.toThrow();
  });

  it("refuses the wake-acceptance store as a deny entry, and accepts the private state directory that covers it", () => {
    const state = `${INSTANCE}/state`;
    const store = `${state}/wake-acceptance`;
    const asDenied = (denyPaths: readonly string[]): DaimonGrokRegistration[] => registrations.map((entry, index) => {
      const denied = index === 0 ? [...denyPaths].sort() : entry.denyPaths;
      const profile = renderDaimonGrokWorkerSandboxProfile(denied);
      return { ...entry, denyPaths: denied, profile, profileSha256: daimonGrokWorkerSandboxProfileSha256(denied) };
    });
    const privateState = { [state]: { gid: 2000, kind: "dir" as const, mode: 0o700, uid: 2000 }, [store]: { gid: 2000, kind: "dir" as const, mode: 0o700, uid: 2000 } };
    const leaf = asDenied([...registrations[0]!.denyPaths.filter((entry) => entry !== state), store]);
    expect(() => run(leaf, { ...seedFor(leaf), ...privateState })).toThrow(new RegExp(`is not placeable: worker uid 2200 cannot search ${state} \\(700 2000:2000\\)`, "u"));
    // What the collector emits instead: the mask on the directory itself, which bubblewrap can place.
    expect(registrations[0]!.denyPaths).toContain(state);
    expect(() => run(registrations, { ...seedFor(registrations), ...privateState })).not.toThrow();
  });
});
