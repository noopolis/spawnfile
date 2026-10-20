import crypto from "node:crypto";
import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { renderDaimonGrokWorkerProvisioning } from "./containerDaimonGrokWorkerProvisioning.js";
import type { DaimonGrokRegistration } from "./containerDaimonGrokWorkerRender.js";

export const INSTANCE = "/var/lib/spawnfile/instances/daimon/daimon-organization";
export const BROKER = 2100;

export type Node = { content: string; gid: number; kind: "dir" | "file" | "link" | "socket"; mode: number; target?: string; uid: number };

/**
 * Just enough of `node:fs` to run the rendered root program without root — including the one
 * capability the container does NOT grant. `spawnfile up` runs the organization container with
 * `--cap-drop ALL` and adds only CHOWN, DAC_READ_SEARCH, KILL, SETGID, SETPCAP and SETUID, so the
 * rendered program runs as uid 0 WITHOUT CAP_DAC_OVERRIDE and WITHOUT CAP_FOWNER: it may chown
 * anything and traverse anything, but it may only create inside a directory the ordinary mode bits
 * let uid 0 write, and only chmod what it owns. Modelling that here is what makes this harness able
 * to fail on a provisioning step that would exit the real container 1 at start.
 */
export const memoryFs = (seed: Record<string, Partial<Node>>) => {
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
    return { gid: node.gid, isDirectory: () => node.kind === "dir", isFile: () => node.kind === "file", isSocket: () => node.kind === "socket", isSymbolicLink: () => node.kind === "link", mode: type | node.mode, nlink: 1, uid: node.uid };
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
      put(target, { kind: "dir", mode: (options.mode ?? 0o755) & ~process.umask() });
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
      put(target, { content: String(content), kind: "file", mode: (options.mode ?? 0o644) & ~process.umask() });
    }
  };
  return { fs, nodes };
};

export const plan = (engines: Record<string, string>): RuntimeTargetPlan => ({
  engineByNodeId: engines,
  grokModelByNodeId: Object.fromEntries(Object.entries(engines).filter(([, engine]) => engine === "grok").map(([id]) => [id, { model: "grok-4.6", reasoningEffort: "low" }])),
  instancePaths: { configPath: `${INSTANCE}/daimon/config.json`, instanceRoot: INSTANCE, workspacePath: `${INSTANCE}/workspace` },
  runtimeName: "daimon"
}) as unknown as RuntimeTargetPlan;

export const seedFor = (registrations: readonly DaimonGrokRegistration[], omit: string[] = []) => Object.fromEntries([
  ...registrations.map((entry) => [entry.workspace, { kind: "dir" as const }] as const),
  ["/etc/daimon-engine-broker", { kind: "dir" as const, mode: 0o700 }] as const,
  ...registrations.flatMap((entry) => entry.denyPaths)
    .filter((denied) => !denied.startsWith("/var/lib/daimon-workers/") && !(["/run/secrets", "/run/spawnfile", "/run/spawnfile-secrets", "/run/world"] as string[]).includes(denied))
    .map((denied) => [denied, { kind: denied.endsWith("grok-bootstrap-auth") ? "file" as const : "dir" as const, mode: 0o700 }] as const)
].filter(([target]) => !omit.includes(target)));

export const run = (registrations: readonly DaimonGrokRegistration[], seed: Record<string, Partial<Node>>, lines = renderDaimonGrokWorkerProvisioning(registrations)) => {
  const memory = memoryFs(seed);
  const secureWorkspace = (): void => undefined;
  const program = new Function("fs", "crypto", "secureWorkspace", "require", lines.join("\n"));
  program(memory.fs, crypto, secureWorkspace, (name: string) => name === "node:path" ? path.posix : name === "node:child_process" ? {
    execFileSync: (_command: string, args: string[]) => {
      const target = args[2]!;
      memory.fs.writeFileSync(target, "", { flag: "wx", mode: 0o600 });
      Object.assign(memory.nodes.get(target)!, { kind: "socket", uid: Number(args[3]), gid: Number(args[4]) });
    }
  } : undefined);
  return memory.nodes;
};
