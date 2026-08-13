import { SpawnfileError } from "../shared/index.js";
import type { DockerTargetExecutors } from "./dockerCommandExecutor.js";
import {
  inspectDockerWorldService,
  sameWorldServiceValue,
  worldServiceSpecForBinding,
} from "./dockerWorldServiceLifecycle.js";
import type { DockerWorldServiceExecutor } from "./dockerWorldServiceProvider.js";
import type { WorldServiceAuthorityReader } from "./dockerWorldServiceStore.js";
import {
  createCanonicalWorldServiceActivationBytes,
  createTargetTopologyActivationReceiptDigest,
  createWorldServiceActivationDigest,
  parseWorldServiceActivation,
} from "./topologyActivation.js";
import {
  createTargetWorldClockReceipt,
  MAX_TARGET_WORLD_CLOCK_BYTES,
  parseTargetWorldClockRequest,
  type TargetWorldClockReceipt,
  type TargetWorldClockRequest,
} from "./worldClock.js";

export const TARGET_WORLD_CLOCK_ERROR = "Target world clock query failed";

export interface DockerWorldClockOptions {
  readonly authorityStore: WorldServiceAuthorityReader;
  readonly context: string;
  readonly contentExecutor: DockerTargetExecutors["publicArtifact"];
  readonly executor: DockerWorldServiceExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}
export interface WorldClockReader { query(raw: unknown): Promise<TargetWorldClockReceipt>; }

const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;
const fail = (): never => { throw new SpawnfileError("runtime_error", TARGET_WORLD_CLOCK_ERROR); };
const options = (raw: DockerWorldClockOptions): DockerWorldClockOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || typeof raw.context !== "string" || !CONTEXT.test(raw.context)
    || typeof raw.contentExecutor !== "function" || typeof raw.executor !== "function"
    || !raw.authorityStore || typeof raw.authorityStore.loadService !== "function"
    || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 120_000
    || raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) return fail();
  return raw;
};
const queryScript = [
  "import http from \"node:http\";",
  "const [rawPort,pathname]=process.argv.slice(1);const port=Number(rawPort);",
  "const fail=()=>{process.exitCode=1;};",
  "if(!Number.isSafeInteger(port)||port<1||port>65535||pathname!==\"/v1/world/clock\")fail();",
  "else http.get({headers:{accept:\"application/json\"},host:\"127.0.0.1\",path:pathname,port},response=>{",
  "const media=response.headers[\"content-type\"];if(response.statusCode!==200||typeof media!==\"string\"||!media.toLowerCase().startsWith(\"application/json\")){response.resume();fail();return;}",
  `const chunks=[];let size=0;response.on("data",chunk=>{size+=chunk.length;if(size>${MAX_TARGET_WORLD_CLOCK_BYTES}){response.destroy();fail();}else chunks.push(chunk);});`,
  "response.on(\"end\",()=>{if(process.exitCode!==1)process.stdout.write(Buffer.concat(chunks));});response.on(\"error\",fail);",
  "}).on(\"error\",fail);",
].join("\n");

const bytes = async (
  optionsValue: DockerWorldClockOptions,
  args: readonly string[],
): Promise<Uint8Array> => {
  const result = await optionsValue.contentExecutor("docker", [
    "--context", optionsValue.context, "container", "exec", ...args,
  ], { signal: optionsValue.signal, timeout: optionsValue.timeoutMs }).catch(fail);
  if (!result || !(result.bytes instanceof Uint8Array)
    || result.bytes.byteLength < 2 || result.bytes.byteLength > MAX_TARGET_WORLD_CLOCK_BYTES) return fail();
  return result.bytes;
};
const json = (raw: Uint8Array): unknown => {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown; }
  catch { return fail(); }
};

class DockerWorldClockReader implements WorldClockReader {
  readonly #options: DockerWorldClockOptions;
  public constructor(input: DockerWorldClockOptions) { this.#options = options(input); }

  public async query(raw: unknown): Promise<TargetWorldClockReceipt> {
    let request: TargetWorldClockRequest;
    try { request = parseTargetWorldClockRequest(raw); } catch { return fail(); }
    const binding = await this.#options.authorityStore
      .loadService(request.world_service_handle).catch(fail);
    const authorization = binding.resolution.authorization;
    if (binding.world_service_handle !== request.world_service_handle
      || authorization.run_id !== request.run_id
      || authorization.descriptor_digest !== request.descriptor_digest
      || !sameWorldServiceValue(authorization.selected_target, request.selected_target)) return fail();
    const spec = worldServiceSpecForBinding(binding);
    const before = await inspectDockerWorldService(binding.container_id, spec, this.#options).catch(fail);
    if (!before || before.containerId !== binding.container_id || before.status !== "running") return fail();
    const markerBytes = await bytes(this.#options, [
      binding.container_id, "/bin/cat",
      `${spec.evidenceMountPath}/.spawnfile/world-service-activated.v1`,
    ]);
    let marker;
    try {
      marker = parseWorldServiceActivation(json(markerBytes));
      if (new TextDecoder().decode(markerBytes) !== createCanonicalWorldServiceActivationBytes(marker)
        || marker.run_id !== request.run_id
        || marker.topology_receipt_digest !== request.topology_receipt_digest
        || marker.topology_request_digest !== request.topology_request_digest
        || createWorldServiceActivationDigest(marker) !== request.activation_digest) return fail();
      const activationBody = {
        activation_digest: request.activation_digest, bundle_digest: marker.bundle_digest,
        receipt_digest: `sha256:${"0".repeat(64)}`, run_id: marker.run_id,
        state: "activated", topology_receipt_digest: marker.topology_receipt_digest,
        topology_request_digest: marker.topology_request_digest,
        version: "spawnfile.target-topology-activation-receipt.v1",
      };
      if (createTargetTopologyActivationReceiptDigest(activationBody)
        !== request.activation_receipt_digest) return fail();
    } catch { return fail(); }
    const observed = json(await bytes(this.#options, [
      binding.container_id, "/usr/local/bin/node", "--input-type=module", "-e",
      queryScript, String(request.endpoint.internal_port), request.endpoint.path,
    ]));
    const after = await inspectDockerWorldService(binding.container_id, spec, this.#options).catch(fail);
    if (!after || after.containerId !== before.containerId || after.status !== "running") return fail();
    try { return createTargetWorldClockReceipt({ observation: observed, request }); }
    catch { return fail(); }
  }
}

export const createDockerWorldClockReader = (
  input: DockerWorldClockOptions,
): WorldClockReader => new DockerWorldClockReader(input);
