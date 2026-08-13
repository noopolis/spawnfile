import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { DockerArtifactProviderError, type DockerArtifactExecutor } from "./dockerArtifactsProvider.js";
import { selectTarget } from "./dockerTarget.js";
import type { DockerTargetLocalBundleBuilder } from "./containerBundle.js";
import type { ParsedContainerBundleArchive } from "./containerBundleArchive.js";

const ERROR = "Target-local container bundle preparation failed";
const BLOCK = 512;
const ID = /^sha256:[a-f0-9]{64}$/u;
const BASE_LABEL = "spawnfile_target_bundle_v1_base";
const ENTRYPOINT_LABEL = "spawnfile_target_bundle_v1_entrypoint";
const fail = (): never => { throw new Error(ERROR); };
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const exact = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const strings = (value: unknown): readonly string[] | null => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
const labels = (value: unknown): Readonly<Record<string, string>> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  return Object.values(result).every((item) => typeof item === "string") ? Object.freeze({ ...(result as Record<string, string>) }) : null;
};
const octal = (value: number, width: number): Buffer => Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
const checksum = (header: Buffer): void => {
  header.fill(0x20, 148, 156); let sum = 0; for (const byte of header) sum += byte;
  header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
};
const ustarPath = (value: string): { readonly name: Buffer; readonly prefix: Buffer } => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= 100) return { name: bytes, prefix: Buffer.alloc(0) };
  const slash = value.lastIndexOf("/"); if (slash < 1) fail();
  const prefix = Buffer.from(value.slice(0, slash), "utf8"); const name = Buffer.from(value.slice(slash + 1), "utf8");
  if (prefix.byteLength > 155 || name.byteLength > 100) fail(); return { name, prefix };
};
/** A canonical, uncompressed USTAR stream. The archive parser has already admitted the bundle paths. */
const tar = (entries: readonly { readonly bytes: Uint8Array; readonly path: string }[]): Uint8Array => {
  const output: Buffer[] = [];
  for (const entry of entries) {
    const { name, prefix } = ustarPath(entry.path); const header = Buffer.alloc(BLOCK);
    header.set(name); header.set(octal(0o644, 8), 100); header.set(octal(0, 8), 108); header.set(octal(0, 8), 116);
    header.set(octal(entry.bytes.byteLength, 12), 124); header.set(octal(0, 12), 136); header[156] = 48;
    header.set(Buffer.from("ustar\x00", "ascii"), 257); header.set(Buffer.from("00", "ascii"), 263); header.set(prefix, 345); checksum(header);
    output.push(header, Buffer.from(entry.bytes)); const pad = (BLOCK - entry.bytes.byteLength % BLOCK) % BLOCK;
    if (pad) output.push(Buffer.alloc(pad));
  }
  output.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)); return Buffer.concat(output);
};
const safeEntrypoint = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(value)
  && !value.includes("//") && !value.split("/").some((part) => part === "." || part === "..");
const dockerfile = (base: string, entrypoint: string): Uint8Array => {
  if (!/^spfb_base_[a-f0-9]{53}$/u.test(base) || !safeEntrypoint(entrypoint)) fail();
  return Buffer.from(`FROM ${base}\nWORKDIR /opt/bundle\nCOPY bundle/ /opt/bundle/\nENTRYPOINT ["node","/opt/bundle/${entrypoint}"]\nCMD []\n`, "utf8");
};
/* Docker 29 errors when a nil Labels map is dereferenced in a Go template.
 * Project Config as one JSON value, then validate its exact security-relevant
 * fields locally; this remains a private Docker inspection. */
const projectionFormat = "[{\"Id\":{{json .Id}},\"Config\":{{json .Config}},\"RootFSType\":{{json .RootFS.Type}},\"RootFSLayers\":{{json .RootFS.Layers}},\"Os\":{{json .Os}},\"Architecture\":{{json .Architecture}}}]";
interface Projection {
  readonly configId: string;
  readonly cmd: readonly string[] | null;
  readonly entrypoint: readonly string[] | null;
  readonly env: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly rootfs: readonly string[];
  readonly user: string;
  readonly workdir: string;
}
const parseProjection = (raw: string): Projection | null => {
  try {
    const value: unknown = JSON.parse(raw); if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") return null;
    const item = value[0] as Record<string, unknown>;
    if (Object.keys(item).sort().join("\0") !== "Architecture\0Config\0Id\0Os\0RootFSLayers\0RootFSType") return null;
    const config = item.Config;
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    const source = config as Record<string, unknown>;
    const itemLabels = source.Labels === undefined || source.Labels === null ? Object.freeze({}) : labels(source.Labels); const entrypoint = source.Entrypoint === undefined || source.Entrypoint === null ? null : strings(source.Entrypoint);
    const cmd = source.Cmd === undefined || source.Cmd === null ? null : strings(source.Cmd); const env = source.Env === undefined || source.Env === null ? Object.freeze([]) : strings(source.Env);
    const rootfs = strings(item.RootFSLayers);
    if (!ID.test(item.Id as string) || !itemLabels || entrypoint === null && source.Entrypoint !== undefined && source.Entrypoint !== null || cmd === null && source.Cmd !== undefined && source.Cmd !== null || !env || !rootfs
      || rootfs.length < 1 || item.RootFSType !== "layers" || (item.Architecture !== "amd64" && item.Architecture !== "arm64") || item.Os !== "linux"
      || source.User !== undefined && source.User !== null && typeof source.User !== "string"
      || source.WorkingDir !== undefined && source.WorkingDir !== null && typeof source.WorkingDir !== "string"
      || source.OnBuild !== undefined && source.OnBuild !== null || source.Volumes !== undefined && source.Volumes !== null
      || source.ExposedPorts !== undefined && source.ExposedPorts !== null || source.Healthcheck !== undefined && source.Healthcheck !== null) return null;
    return Object.freeze({ configId: item.Id as string, cmd, entrypoint, env, labels: itemLabels,
      platform: Object.freeze({ architecture: item.Architecture, os: "linux" }), rootfs: Object.freeze([...rootfs]), user: source.User ?? "", workdir: source.WorkingDir ?? "" });
  } catch { return null; }
};
const isSafeBase = (value: Projection, expectedId: string, platform: Projection["platform"]): boolean =>
  /* Dockerfile deterministically replaces the inherited workdir, entrypoint,
   * and command. Those base defaults therefore cannot affect the output or
   * execute during this COPY-only build; rejecting them would exclude the
   * reviewed node base. OnBuild remains forbidden because it can execute
   * while building, and labels/user remain constrained because they persist. */
  value.configId === expectedId && exact(value.labels, {}) && value.user === ""
  && exact(value.platform, platform);
const expectedEntrypoint = (value: Readonly<Record<string, string>>): readonly string[] | null => {
  const entrypoint = value[ENTRYPOINT_LABEL]; return safeEntrypoint(entrypoint) ? Object.freeze(["node", `/opt/bundle/${entrypoint}`]) : null;
};
const isOutput = (value: Projection, input: { readonly base: Projection; readonly configId?: string; readonly labels: Readonly<Record<string, string>>; readonly platform: Projection["platform"] }): boolean => {
  const entrypoint = expectedEntrypoint(input.labels);
  return (!input.configId || value.configId === input.configId) && entrypoint !== null && exact(value.labels, input.labels)
    // Docker normalizes the explicit `CMD []` in the generated Dockerfile to
    // a null Config.Cmd.  Null is therefore the exact no-inherited-command
    // representation we attest on real daemons.
    && exact(value.entrypoint, entrypoint) && exact(value.cmd, null) && exact(value.env, input.base.env)
    && value.user === "" && value.workdir === "/opt/bundle" && exact(value.platform, input.platform)
    && value.rootfs.length > input.base.rootfs.length && input.base.rootfs.every((layer, index) => value.rootfs[index] === layer);
};
const daemonEpoch = (id: string): string => `sha256:${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.daemon-epoch.v1\0", "utf8").update(id, "utf8").digest("hex")}`;
/* Bound to both output request and base config: no other operation can safely inherit this scratch tag. */
const baseTag = (configId: string, gcTag: string): string => `spfb_base_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.base-tag.v2\0", "utf8").update(`${configId}\0${gcTag}`, "utf8").digest("hex").slice(0, 53)}`;

/** Private Docker lowering. It refuses tag adoption; durable post-build recovery uses inspect() instead. */
export const createDockerTargetLocalBundleBuilder = (input: { readonly context: string; readonly executor: DockerArtifactExecutor; readonly timeoutMs?: number }): DockerTargetLocalBundleBuilder => {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(input.context) || typeof input.executor !== "function") fail();
  const timeout = input.timeoutMs ?? 30_000;
  const execute = async (args: string[], stdin?: Uint8Array): Promise<string> => {
    const result = await input.executor("docker", args, { timeout, ...(stdin ? { stdin } : {}) } as never);
    if (!result || Buffer.byteLength(result.stdout, "utf8") > 65_536 || Buffer.byteLength(result.stderr, "utf8") > 65_536) fail(); return result.stdout;
  };
  const read = async (reference: string): Promise<Projection> => {
    const value = parseProjection(await execute(["--context", input.context, "image", "inspect", "--format", projectionFormat, reference]));
    return value ?? fail();
  };
  const readMaybe = async (reference: string): Promise<Projection | "missing"> => {
    try { return await read(reference); }
    catch (error) {
      if (error instanceof DockerArtifactProviderError && error.kind === "image_not_found") return "missing";
      throw error;
    }
  };
  const absent = async (reference: string): Promise<boolean> => (await readMaybe(reference)) === "missing";
  const base = async (configId: string, platform: Projection["platform"]): Promise<Projection> => {
    if (!ID.test(configId)) fail(); const result = await read(configId); if (!isSafeBase(result, configId, platform)) fail(); return result;
  };
  const inspect = async (configId: string, gcTag: string, expected: { readonly labels: Readonly<Record<string, string>>; readonly platform: Projection["platform"] }) => {
    const baseId = expected.labels[BASE_LABEL]; if (!ID.test(baseId)) return null;
    const baseImage = await base(baseId, expected.platform).catch(() => null); if (!baseImage) return null;
    const byId = await readMaybe(configId); const byTag = await readMaybe(gcTag);
    if (byId === "missing" || byTag === "missing") return null;
    if (byId.configId !== byTag.configId || !isOutput(byId, { base: baseImage, ...(ID.test(configId) ? { configId } : {}), ...expected })) return null;
    return Object.freeze({ config_id: byId.configId, labels: Object.freeze({ ...expected.labels }), platform: expected.platform });
  };
  const inspectAnchor = async (gcTag: string, expected: { readonly labels: Readonly<Record<string, string>>; readonly platform: Projection["platform"] }) => {
    const byTag = await readMaybe(gcTag);
    if (byTag === "missing") return "missing" as const;
    return inspect(byTag.configId, gcTag, expected);
  };
  const builder: DockerTargetLocalBundleBuilder = {
    attestTarget: async ({ selected_target }) => {
      const selected = await selectTarget({ context: input.context, execFile: async (_file, args) => ({ stderr: "", stdout: await execute(args) }), timeoutMs: timeout });
      if (!exact({ fingerprint: selected.fingerprint, handle: selected.handle }, selected_target)) return null;
      const raw = (await execute(["--context", input.context, "info", "--format", "{{json .ID}}"])) .trim();
      let id: unknown; try { id = JSON.parse(raw); } catch { return null; }
      return typeof id === "string" && id.length > 0 ? Object.freeze({ daemon_epoch: daemonEpoch(id) }) : null;
    },
    build: async ({ archive, base_image_config_digest, entrypoint, gc_tag, labels: expectedLabels, platform }) => {
      if (!/^spfb_[a-f0-9]{58}$/u.test(gc_tag) || !safeEntrypoint(entrypoint) || expectedLabels[ENTRYPOINT_LABEL] !== entrypoint
        || expectedLabels[BASE_LABEL] !== base_image_config_digest) fail();
      const baseImage = await base(base_image_config_digest, platform);
      /* Any output tag, even a seemingly matching one, belongs to recovery rather than a new build. */
      if (!await absent(gc_tag)) fail();
      const scratch = baseTag(base_image_config_digest, gc_tag);
      if (!await absent(scratch)) fail();
      let ownScratch = false;
      try {
        const tagResult = await execute(["--context", input.context, "image", "tag", base_image_config_digest, scratch]);
        if (tagResult.trim() !== "") fail(); ownScratch = true;
        const pinned = await read(scratch); if (!isSafeBase(pinned, base_image_config_digest, platform)) fail();
        const context = tar([{ path: "Dockerfile", bytes: dockerfile(scratch, entrypoint) }, ...archive.entries.map((entry) => ({ path: `bundle/${entry.path}`, bytes: entry.bytes }))]);
        const labelArgs = Object.entries(expectedLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
        await execute(["--context", input.context, "build", "--pull=false", "--network=none", "--platform", `${platform.os}/${platform.architecture}`, "--tag", gc_tag, ...labelArgs, "-"], context);
        const result = await inspect(gc_tag, gc_tag, { labels: expectedLabels, platform }); if (!result) fail(); return result as NonNullable<typeof result>;
      } finally {
        if (ownScratch) {
          const pinned = await read(scratch);
          if (!isSafeBase(pinned, base_image_config_digest, platform)) fail();
          const removed = await execute(["--context", input.context, "image", "rm", scratch]); if (removed.trim().length > 4_096) fail();
        }
      }
    },
    inspect: async ({ config_id, gc_tag, labels: expectedLabels, platform }) => inspect(config_id, gc_tag, { labels: expectedLabels, platform }),
    inspectAnchor: async ({ gc_tag, labels: expectedLabels, platform }) => inspectAnchor(gc_tag, { labels: expectedLabels, platform })
  };
  return Object.freeze(builder);
};
