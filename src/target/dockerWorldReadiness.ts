import { SpawnfileError } from "../shared/index.js";
import { types as nodeTypes } from "node:util";
import type { DockerTargetExecutors } from "./dockerCommandExecutor.js";
import {
  type DockerWorldServiceExecutor
} from "./dockerWorldServiceProvider.js";
import {
  inspectDockerWorldService,
  sameWorldServiceValue,
  worldServiceSpecForBinding
} from "./dockerWorldServiceLifecycle.js";
import type { WorldServiceAuthorityReader } from "./dockerWorldServiceStore.js";
import {
  createTargetWorldReadinessReceipt,
  MAX_TARGET_WORLD_READINESS_BYTES,
  parseTargetWorldReadinessRequest,
  type TargetWorldReadinessReceipt,
  type TargetWorldReadinessRequest
} from "./worldReadiness.js";

export const TARGET_WORLD_READINESS_ERROR = "Target world readiness query failed";

export interface DockerWorldReadinessOptions {
  readonly authorityStore: WorldServiceAuthorityReader;
  readonly context: string;
  readonly contentExecutor: DockerTargetExecutors["publicArtifact"];
  readonly executor: DockerWorldServiceExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface WorldReadinessReader {
  query(raw: unknown): Promise<TargetWorldReadinessReceipt>;
}

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const fail = (): never => {
  throw new SpawnfileError("runtime_error", TARGET_WORLD_READINESS_ERROR);
};
const validOptions = (raw: DockerWorldReadinessOptions): DockerWorldReadinessOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const required = [
    "authorityStore", "context", "contentExecutor", "executor", "timeoutMs"
  ];
  const expected = Object.hasOwn(descriptors, "signal") ? [...required, "signal"] : required;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || Object.values(descriptors).some((descriptor) =>
      !descriptor.enumerable || !("value" in descriptor))) return fail();
  const values = Object.fromEntries(expected.map((key) =>
    [key, descriptors[key]!.value])) as unknown as DockerWorldReadinessOptions;
  if (typeof values.context !== "string" || !CONTEXT_PATTERN.test(values.context)
    || typeof values.contentExecutor !== "function"
    || typeof values.executor !== "function"
    || !values.authorityStore || typeof values.authorityStore.loadService !== "function"
    || !Number.isSafeInteger(values.timeoutMs) || values.timeoutMs < 1
    || values.timeoutMs > 120_000
    || values.signal !== undefined && !(values.signal instanceof AbortSignal)) return fail();
  return Object.freeze(values);
};

const exactBinding = async (
  request: TargetWorldReadinessRequest,
  options: DockerWorldReadinessOptions
) => {
  const binding = await options.authorityStore.loadService(request.world_service_handle);
  const authorization = binding.resolution.authorization;
  if (binding.world_service_handle !== request.world_service_handle
    || authorization.run_id !== request.run_id
    || authorization.descriptor_digest !== request.descriptor_digest
    || !sameWorldServiceValue(authorization.selected_target, request.selected_target)) return fail();
  return binding;
};

const queryScript = [
  "import http from \"node:http\";",
  "const [rawPort, pathname] = process.argv.slice(1);",
  "const port = Number(rawPort);",
  "const fail = () => { process.exitCode = 1; };",
  "if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || pathname !== \"/v1/world/readiness\") fail();",
  "else http.get({headers:{accept:\"application/json\"},host:\"127.0.0.1\",path:pathname,port}, response => {",
  "const mediaType = response.headers[\"content-type\"];",
  "if (response.statusCode !== 200 || typeof mediaType !== \"string\" || !mediaType.toLowerCase().startsWith(\"application/json\")) { response.resume(); fail(); return; }",
  "const chunks = []; let size = 0;",
  `response.on("data", chunk => { size += chunk.length; if (size > ${MAX_TARGET_WORLD_READINESS_BYTES}) { response.destroy(); fail(); } else chunks.push(chunk); });`,
  "response.on(\"end\", () => { if (process.exitCode !== 1) process.stdout.write(Buffer.concat(chunks)); });",
  "response.on(\"error\", fail);",
  "}).on(\"error\", fail);"
].join("\n");

const queryWorld = async (
  containerId: string,
  request: TargetWorldReadinessRequest,
  options: DockerWorldReadinessOptions
): Promise<unknown> => {
  try {
    const result = await options.contentExecutor("docker", [
      "--context", options.context,
      "container", "exec",
      containerId,
      "/usr/local/bin/node",
      "--input-type=module",
      "-e",
      queryScript,
      String(request.endpoint.internal_port),
      request.endpoint.path
    ], {
      signal: options.signal,
      timeout: options.timeoutMs
    });
    if (!result || !(result.bytes instanceof Uint8Array)
      || result.bytes.byteLength < 2
      || result.bytes.byteLength > MAX_TARGET_WORLD_READINESS_BYTES) return fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return fail();
  }
};

class DockerWorldReadinessReader implements WorldReadinessReader {
  readonly #options: DockerWorldReadinessOptions;

  public constructor(options: DockerWorldReadinessOptions) {
    this.#options = validOptions(options);
  }

  public async query(raw: unknown): Promise<TargetWorldReadinessReceipt> {
    let request: TargetWorldReadinessRequest;
    try { request = parseTargetWorldReadinessRequest(raw); }
    catch { return fail(); }
    const binding = await exactBinding(request, this.#options).catch(fail);
    const spec = worldServiceSpecForBinding(binding);
    const before = await inspectDockerWorldService(
      binding.container_id,
      spec,
      this.#options
    ).catch(fail);
    if (!before || before.containerId !== binding.container_id
      || before.status !== "running") return fail();

    const document = await queryWorld(binding.container_id, request, this.#options);
    const after = await inspectDockerWorldService(
      binding.container_id,
      spec,
      this.#options
    ).catch(fail);
    if (!after || after.containerId !== before.containerId
      || after.status !== "running") return fail();
    try { return createTargetWorldReadinessReceipt({ document, request }); }
    catch { return fail(); }
  }
}

export const createDockerWorldReadinessReader = (
  options: DockerWorldReadinessOptions
): WorldReadinessReader => new DockerWorldReadinessReader(options);
