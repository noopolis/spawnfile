import { spawn } from "node:child_process";
import { types as nodeTypes } from "node:util";

import {
  DockerOrganizationAttachmentProviderError,
  type DockerOrganizationAttachmentExecutor
} from "./organizationAttachmentProvider.js";
import { DockerArtifactProviderError, type DockerArtifactExecutor } from "./dockerArtifactsProvider.js";
import {
  DockerResourceProviderError,
  type DockerResourceExecutor
} from "./dockerResourcesProvider.js";
import {
  DockerSecretProviderError,
  type DockerSecretExecutor
} from "./dockerSecretsProvider.js";
import {
  DockerWorldServiceProviderError,
  type DockerWorldServiceExecutor
} from "./dockerWorldServiceProvider.js";
import type { DockerEvidenceExportExecutor } from "./evidenceExportProvider.js";
import {
  MAX_TARGET_PUBLIC_ARTIFACT_BYTES,
  isTargetPublicArtifactPath
} from "./publicArtifactSnapshot.js";
import {
  DOCKER_COMMAND_ERROR,
  DockerCommandFailure,
  executeDockerCommandCore,
  type DockerCommandSpawn
} from "./dockerCommandExecutorCore.js";

type AdapterKind = "artifact" | "attachment" | "resource" | "secret" | "world";

const PUBLIC_ARTIFACT_NOT_PRESENT_EXIT = 42;
// The public directory is a separately mounted tmpfs and paths are restricted
// to direct children.  Open the leaf exactly once with O_NOFOLLOW: no path
// preflight is permitted because it would turn a replacement into a TOCTOU
// disclosure.  Only ENOENT from that open denotes the terminal absence state.
export const PUBLIC_ARTIFACT_READER_PROGRAM = [
  "import fs from 'node:fs';",
  "const path = process.argv[1];",
  "let fd;",
  "try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }",
  "catch (error) { process.exitCode = error?.code === 'ENOENT' ? 42 : 43; }",
  "if (fd !== undefined) {",
  "  try {",
  "    if (!fs.fstatSync(fd).isFile()) process.exitCode = 43;",
  "    else { const chunks = []; let bytes; do { const chunk = Buffer.allocUnsafe(65536); bytes = fs.readSync(fd, chunk); if (bytes) chunks.push(chunk.subarray(0, bytes)); } while (bytes); process.stdout.write(Buffer.concat(chunks)); }",
  "  } catch { process.exitCode = 43; } finally { fs.closeSync(fd); }",
  "}"
].join(" ");

/** Private control signal emitted only for an exact missing public path probe. */
export class DockerPublicArtifactNotPresentError extends Error {
  public readonly kind = "not_present" as const;

  public constructor() {
    super("Target public artifact is not present");
    this.name = "DockerPublicArtifactNotPresentError";
  }
}

const role = (args: readonly string[]): readonly string[] => {
  if (args[0] === "--context") {
    return args.length >= 3 && /^[a-z][a-z0-9_-]{0,63}$/u.test(args[1]!) ? args.slice(2) : [];
  }
  if (args[0] === "--config") {
    return args.length >= 5 && typeof args[1] === "string" && args[1]!.startsWith("/")
      && args[1]!.length <= 4_096 && !/\s/u.test(args[1]!)
      && args[2] === "--context" && /^[a-z][a-z0-9_-]{0,63}$/u.test(args[3]!)
      ? args.slice(4) : [];
  }
  return args;
};
const exactPublicArtifactAbsence = (
  args: readonly string[],
  error: unknown
): DockerPublicArtifactNotPresentError | undefined => {
  if (!(error instanceof DockerCommandFailure)
    || error.code !== PUBLIC_ARTIFACT_NOT_PRESENT_EXIT || error.stderr !== ""
    || error.stdoutBytes !== 0) return undefined;
  const command = role(args);
  const path = command[8];
  if (command.length !== 9
    || command[0] !== "container" || command[1] !== "exec"
    || !/^[a-f0-9]{64}$/u.test(command[2]!)
    || command[3] !== "/usr/local/bin/node" || command[4] !== "--input-type=module"
    || command[5] !== "-e" || command[6] !== PUBLIC_ARTIFACT_READER_PROGRAM
    || command[7] !== "spawnfile-public-artifact-read"
    || !isTargetPublicArtifactPath(path)) return undefined;
  return new DockerPublicArtifactNotPresentError();
};
const exactMissingImageReference = (requested: string | undefined, reported: string): boolean => {
  if (requested === undefined || reported === requested) return reported === requested;
  const lastSlash = requested.lastIndexOf("/");
  const lastColon = requested.lastIndexOf(":");
  const hasExplicitTagOrDigest = requested.includes("@") || lastColon > lastSlash;
  return !hasExplicitTagOrDigest && reported === `${requested}:latest`;
};
const exactVolumeAbsence = (
  kind: AdapterKind,
  command: readonly string[],
  message: string
): DockerResourceProviderError | DockerSecretProviderError | undefined => {
  if (kind !== "resource" && kind !== "secret") return undefined;
  const inspect = command.length === 3 && command[0] === "volume" && command[1] === "inspect"
    || command.length === 5 && command[0] === "volume" && command[1] === "inspect"
      && command[2] === "--format" && typeof command[3] === "string" && command[3]!.length > 0;
  const remove = command.length === 3 && command[0] === "volume" && command[1] === "rm";
  if (!inspect && !remove) return undefined;
  const oldForm = /^(?:Error response from daemon: )?No such volume: ([A-Za-z0-9_.:-]+)$/u.exec(message);
  const docker29Form = /^Error response from daemon: get ([A-Za-z0-9_.:-]+): no such volume$/u.exec(message);
  const reported = oldForm?.[1] ?? docker29Form?.[1];
  if (reported === undefined || reported !== command.at(-1)) return undefined;
  return kind === "resource"
    ? new DockerResourceProviderError("not_found")
    : new DockerSecretProviderError("not_found");
};
const classify = (kind: AdapterKind, args: readonly string[], error: unknown): Error => {
  if (!(error instanceof DockerCommandFailure)
    || !Number.isInteger(error.code) || error.code <= 0) return new Error(DOCKER_COMMAND_ERROR);
  const command = role(args);
  const message = error.stderr.trim();
  const missingImage = /^(?:Error response from daemon: )?No such image: ([A-Za-z0-9_.:@/-]+)$/u.exec(message);
  if (kind === "artifact" && command[0] === "image" && command[1] === "inspect"
    && missingImage && exactMissingImageReference(command.at(-1), missingImage[1]!)) {
    return new DockerArtifactProviderError("image_not_found");
  }
  const missingVolume = exactVolumeAbsence(kind, command, message);
  if (missingVolume) return missingVolume;
  const docker29MissingNetwork =
    /^Error response from daemon: network ([A-Za-z0-9_.:-]+) not found$/u.exec(message);
  if (kind === "resource" && command[0] === "network"
    && (command[1] === "inspect" || command[1] === "rm")
    && docker29MissingNetwork?.[1] === command.at(-1)) {
    return new DockerResourceProviderError("not_found");
  }
  let collisionNoun: "container" | "network" | "volume" | undefined;
  if (/^(?:Error response from daemon: )?network with name [A-Za-z0-9_.:-]+ already exists$/u.test(message)) collisionNoun = "network";
  else if (/^(?:Error response from daemon: )?volume [A-Za-z0-9_.:-]+ already exists$/u.test(message)) collisionNoun = "volume";
  else if (/^(?:Error response from daemon: )?Conflict\. The container name "[A-Za-z0-9_.:/-]+" is already in use by container "[a-f0-9]{12,64}"\.$/u.test(message)) collisionNoun = "container";
  const createNoun = command[0] === "run" ? "container"
    : command[1] === "create" && ["container", "network", "volume"].includes(command[0]!)
      ? command[0] : undefined;
  if (collisionNoun && collisionNoun === createNoun) {
    if (kind === "resource" && collisionNoun !== "container") return new DockerResourceProviderError("collision");
    if (kind === "secret" && (collisionNoun === "volume" || collisionNoun === "container")) return new DockerSecretProviderError("collision");
    if (kind === "world" && collisionNoun === "container") return new DockerWorldServiceProviderError("collision");
  }
  const missing = /^(?:Error response from daemon: )?No such (container|network): [A-Za-z0-9_.:/-]+$/u.exec(message);
  const noun = command[0];
  const mutation = command[1];
  const roleEligible = kind === "resource"
    ? (noun === "network" || noun === "volume")
      && (mutation === "inspect" || mutation === "rm")
    : kind === "secret"
      ? noun === "volume" && (mutation === "inspect" || mutation === "rm")
        || noun === "container" && ["inspect", "rm", "wait", "stop"].includes(mutation!)
      : kind === "attachment"
        ? noun === "container" && mutation === "inspect"
          || noun === "network" && ["inspect", "connect", "disconnect"].includes(mutation!)
        : noun === "container" && ["inspect", "rm", "stop"].includes(mutation!);
  const nounMatches = Boolean(missing) && (missing![1] === command[0]
    || kind === "attachment" && command[0] === "network"
      && (mutation === "connect" || mutation === "disconnect")
      && (missing![1] === "network" || missing![1] === "container"));
  if (roleEligible && nounMatches) {
    if (kind === "resource" && missing![1] === "network") return new DockerResourceProviderError("not_found");
    if (kind === "secret" && missing![1] === "container") return new DockerSecretProviderError("not_found");
    if (kind === "attachment") return new DockerOrganizationAttachmentProviderError("not_found");
    if (kind === "world" && missing![1] === "container") return new DockerWorldServiceProviderError("not_found");
  }
  return new Error(DOCKER_COMMAND_ERROR);
};

export interface DockerTargetExecutors {
  readonly artifact: DockerArtifactExecutor;
  readonly attachment: DockerOrganizationAttachmentExecutor;
  readonly evidenceExport: DockerEvidenceExportExecutor;
  readonly publicArtifact: (
    file: string,
    args: readonly string[],
    options: { readonly signal?: AbortSignal; readonly timeout: number }
  ) => Promise<{ readonly bytes: Uint8Array }>;
  readonly resource: DockerResourceExecutor;
  readonly secret: DockerSecretExecutor;
  readonly world: DockerWorldServiceExecutor;
}

export const createPublicArtifactReadCommand = (input: {
  readonly containerId: string;
  readonly context: string;
  readonly path: string;
}): string[] => [
  "--context", input.context, "container", "exec", input.containerId,
  "/usr/local/bin/node", "--input-type=module", "-e", PUBLIC_ARTIFACT_READER_PROGRAM,
  "spawnfile-public-artifact-read", input.path
];
export interface CreateDockerTargetExecutorsOptions {
  readonly dockerCommand?: string;
  readonly spawn?: DockerCommandSpawn;
}
interface NormalizedCommandOptions {
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
  readonly timeout: number;
}
const normalizeCommandOptions = (
  raw: unknown,
  allowStdin: boolean
): NormalizedCommandOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error(DOCKER_COMMAND_ERROR);
  const keys = Reflect.ownKeys(raw);
  const allowed = allowStdin ? ["signal", "stdin", "timeout"] : ["signal", "timeout"];
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || !keys.includes("timeout")) throw new Error(DOCKER_COMMAND_ERROR);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some((descriptor) =>
    !descriptor.enumerable || !("value" in descriptor))) throw new Error(DOCKER_COMMAND_ERROR);
  return {
    signal: descriptors.signal?.value as AbortSignal | undefined,
    stdin: descriptors.stdin?.value as Uint8Array | undefined,
    timeout: descriptors.timeout!.value as number
  };
};
export const createDockerTargetExecutors = (
  options: CreateDockerTargetExecutorsOptions = {}
): DockerTargetExecutors => {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || nodeTypes.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new Error(DOCKER_COMMAND_ERROR);
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string"
    || !["dockerCommand", "spawn"].includes(key))
    || Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
    throw new Error(DOCKER_COMMAND_ERROR);
  }
  const spawnCommand = descriptors.spawn?.value as DockerCommandSpawn | undefined
    ?? spawn as unknown as DockerCommandSpawn;
  const dockerCommand = descriptors.dockerCommand?.value as string | undefined ?? "docker";
  if (typeof spawnCommand !== "function") throw new Error(DOCKER_COMMAND_ERROR);
  const text = (kind?: AdapterKind) => async (file: string, args: string[], commandOptions: { readonly signal?: AbortSignal; readonly stdin?: Uint8Array; readonly timeout: number }) => {
    try {
      if (file !== "docker") throw new Error(DOCKER_COMMAND_ERROR);
      const normalized = normalizeCommandOptions(commandOptions, true);
      const result = await executeDockerCommandCore(spawnCommand, dockerCommand, args, {
        ...normalized, binary: false
      });
      return { stderr: result.stderr, stdout: result.stdout as string };
    } catch (error) { throw kind ? classify(kind, args, error) : new Error(DOCKER_COMMAND_ERROR); }
  };
  return Object.freeze({
    artifact: text("artifact"),
    attachment: text("attachment"),
    evidenceExport: async (file: string, args: readonly string[], commandOptions: { readonly signal?: AbortSignal; readonly timeout: number }) => {
      try {
        if (file !== "docker") throw new Error(DOCKER_COMMAND_ERROR);
        const normalized = normalizeCommandOptions(commandOptions, false);
        const result = await executeDockerCommandCore(spawnCommand, dockerCommand, args, {
          ...normalized, binary: true
        });
        return { bytes: result.stdout as Uint8Array };
      } catch { throw new Error(DOCKER_COMMAND_ERROR); }
    },
    publicArtifact: async (file: string, args: readonly string[], commandOptions: { readonly signal?: AbortSignal; readonly timeout: number }) => {
      try {
        if (file !== "docker") throw new Error(DOCKER_COMMAND_ERROR);
        const normalized = normalizeCommandOptions(commandOptions, false);
        const result = await executeDockerCommandCore(spawnCommand, dockerCommand, args, {
          ...normalized,
          binary: true,
          stdoutCap: MAX_TARGET_PUBLIC_ARTIFACT_BYTES
        });
        return { bytes: Uint8Array.from(result.stdout as Uint8Array) };
      } catch (error) {
        const absence = exactPublicArtifactAbsence(args, error);
        if (absence) throw absence;
        throw new Error(DOCKER_COMMAND_ERROR);
      }
    },
    resource: text("resource"),
    secret: text("secret"),
    world: text("world")
  });
};
export type { DockerCommandSpawn } from "./dockerCommandExecutorCore.js";
