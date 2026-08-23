import { createHash } from "node:crypto";

import { parseDockerBaseImageReference } from "../target/dockerBaseImage.js";
import {
  DockerArtifactProviderError,
} from "../target/dockerArtifactsProvider.js";
import {
  EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL,
  EVIDENCE_EXPORT_HELPER_CONTRACT_VERSION,
  EVIDENCE_EXPORT_HELPER_ENTRYPOINT,
  EVIDENCE_EXPORT_HELPER_ENV,
  EVIDENCE_EXPORT_HELPER_USER,
} from "../target/evidenceExportProvider.js";

import {
  createPreparedEvidenceHelperKey,
  initializePreparedEvidenceHelperAuthorityStore,
  newPreparedEvidenceHelperCompletionRecord,
  newPreparedEvidenceHelperPendingRecord,
  type PreparedEvidenceHelperAuthority,
  type PreparedEvidenceHelperPendingRecord,
  type PreparedEvidenceHelperReceipt,
} from "./preparedAuthority.js";
import { loadLocalEvidenceHelperRecipe, type LocalEvidenceHelperRecipe } from "./recipe.js";
import type { PrepareEvidenceHelperInput } from "./preparedBuilderTypes.js";

export type { PrepareEvidenceHelperInput } from "./preparedBuilderTypes.js";

const ERROR = "Prepared evidence-export helper failed";
const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const BUILD_ID = /^(sha256:[a-f0-9]{64})(?:\r?\n)?$/u;
const MAX_OUTPUT = 65_536;
const BASE_FORMAT = "[{\"Architecture\":{{json .Architecture}},\"Id\":{{json .Id}},\"Os\":{{json .Os}}}]";
const IMAGE_FORMAT = "[{\"Architecture\":{{json .Architecture}},\"Config\":{\"Cmd\":{{json (index .Config \"Cmd\")}},\"Entrypoint\":{{json (index .Config \"Entrypoint\")}},\"Env\":{{json (index .Config \"Env\")}},\"ExposedPorts\":{{json (index .Config \"ExposedPorts\")}},\"Healthcheck\":{{json (index .Config \"Healthcheck\")}},\"Labels\":{{json (index .Config \"Labels\")}},\"User\":{{json (index .Config \"User\")}},\"Volumes\":{{json (index .Config \"Volumes\")}}},\"Id\":{{json .Id}},\"Os\":{{json .Os}}}]";
const live = new Map<string, Promise<PreparedEvidenceHelperReceipt>>();

interface Facts {
  readonly baseConfig: `sha256:${string}`;
  readonly daemonDigest: `sha256:${string}`;
  readonly endpointDigest: `sha256:${string}`;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
}

const fail = (): never => { throw new Error(ERROR); };
const hash = (domain: string, value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(`spawnfile.evidence-helper.${domain}.v1\0`).update(value).digest("hex")}`;
const exact = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
  && Object.getPrototypeOf(raw) === Object.prototype
  && Object.keys(raw).sort().join("\0") === [...keys].sort().join("\0");
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const digest = (raw: unknown): `sha256:${string}` =>
  typeof raw === "string" && DIGEST.test(raw) ? raw as `sha256:${string}` : fail();
const timeout = (raw: unknown): number => raw === undefined ? 120_000
  : typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= 120_000 ? raw : fail();
const parse = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return fail(); } };
const hook = async (value: (() => Promise<void> | void) | undefined): Promise<void> => { if (value) await value(); };

const execution = (input: PrepareEvidenceHelperInput, value: number) => {
  if (!CONTEXT.test(input.context) || typeof input.executor !== "function") return fail();
  const run = async (args: string[], stdin?: Uint8Array): Promise<string> => {
    const result = await input.executor("docker", ["--context", input.context, ...args], {
      ...(input.signal ? { signal: input.signal } : {}), timeout: value, ...(stdin ? { stdin } as never : {}),
    } as never);
    if (!result || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT || Buffer.byteLength(result.stderr, "utf8") > MAX_OUTPUT) return fail();
    return result.stdout;
  };
  return Object.freeze({ run });
};
const localFacts = async (
  run: ReturnType<typeof execution>["run"],
  context: string,
  baseImage: string,
): Promise<Facts> => {
  const endpoint = parse((await run([
    "context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}",
  ])).trim());
  if (typeof endpoint !== "string" || !/^(?:fd|npipe|unix):\/\/[^\s]+$/u.test(endpoint)) return fail();
  const daemon = parse(await run(["info", "--format", "{\"Architecture\":{{json .Architecture}},\"DockerRootDir\":{{json .DockerRootDir}},\"OSType\":{{json .OSType}},\"ServerVersion\":{{json .ServerVersion}}}"]));
  if (!exact(daemon, ["Architecture", "DockerRootDir", "OSType", "ServerVersion"])
    || daemon.OSType !== "linux" || typeof daemon.DockerRootDir !== "string" || typeof daemon.ServerVersion !== "string") return fail();
  const architecture = ["amd64", "x64", "x86_64"].includes(daemon.Architecture as string) ? "amd64" as const
    : ["arm64", "aarch64"].includes(daemon.Architecture as string) ? "arm64" as const : fail();
  const image = parse(await run(["image", "inspect", baseImage, "--format", BASE_FORMAT]));
  if (!Array.isArray(image) || image.length !== 1 || !exact(image[0], ["Architecture", "Id", "Os"])
    || image[0].Os !== "linux" || image[0].Architecture !== architecture) return fail();
  return Object.freeze({ baseConfig: digest(image[0].Id), daemonDigest: hash("daemon", JSON.stringify(daemon)),
    endpointDigest: hash("endpoint", endpoint), platform: Object.freeze({ architecture, os: "linux" as const }) });
};
const inspectHelper = async (run: ReturnType<typeof execution>["run"], reference: string, facts: Facts): Promise<`sha256:${string}`> => {
  const image = parse(await run(["image", "inspect", reference, "--format", IMAGE_FORMAT]));
  if (!Array.isArray(image) || image.length !== 1 || !exact(image[0], ["Architecture", "Config", "Id", "Os"])
    || image[0].Architecture !== facts.platform.architecture || image[0].Os !== "linux"
    || !exact(image[0].Config, ["Cmd", "Entrypoint", "Env", "ExposedPorts", "Healthcheck", "Labels", "User", "Volumes"])) return fail();
  const config = image[0].Config as Record<string, unknown>;
  if (!same(config.Entrypoint, EVIDENCE_EXPORT_HELPER_ENTRYPOINT)
    || config.Cmd !== null && !same(config.Cmd, []) || !same(config.Env, EVIDENCE_EXPORT_HELPER_ENV)
    || config.ExposedPorts !== null
    || config.Healthcheck !== null || config.Volumes !== null || config.User !== EVIDENCE_EXPORT_HELPER_USER
    || !exact(config.Labels, [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL])
    || config.Labels[EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL] !== EVIDENCE_EXPORT_HELPER_CONTRACT_VERSION) return fail();
  return digest(image[0].Id);
};
const inspectMaybe = async (run: ReturnType<typeof execution>["run"], reference: string,
  facts: Facts): Promise<`sha256:${string}` | null> => {
  try { return await inspectHelper(run, reference, facts); }
  catch (error) { if (error instanceof DockerArtifactProviderError && error.kind === "image_not_found") return null; throw error; }
};
const matching = (record: PreparedEvidenceHelperPendingRecord, baseImage: string,
  facts: Facts, recipe: LocalEvidenceHelperRecipe): boolean =>
  record.base_image === baseImage && record.base_config_digest === facts.baseConfig && record.daemon_digest === facts.daemonDigest
  && record.endpoint_digest === facts.endpointDigest && same(record.platform, facts.platform)
  && record.recipe_digest === recipe.recipeDigest;
const build = async (input: PrepareEvidenceHelperInput, run: ReturnType<typeof execution>["run"],
  facts: Facts, recipe: LocalEvidenceHelperRecipe): Promise<`sha256:${string}`> => {
  await hook(input.testHooks?.beforeBuild);
  const output = await run(["build", "--quiet", "--pull=false", "--network=none", "--platform",
    `${facts.platform.os}/${facts.platform.architecture}`, "--build-arg", `SPAWNFILE_HELPER_BASE=${facts.baseConfig}`,
    "-"], recipe.context);
  const produced = BUILD_ID.exec(output)?.[1];
  if (!produced) return fail();
  await hook(input.testHooks?.afterBuild);
  // Docker's quiet build result is the image config ID produced by this exact
  // invocation. Re-attest that immutable ID, never a mutable tag.
  const inspected = await inspectHelper(run, produced, facts);
  return inspected === produced ? inspected : fail();
};
const receiptOwner = async (input: PrepareEvidenceHelperInput, baseImage: string, facts: Facts,
  recipe: LocalEvidenceHelperRecipe, key: string, run: ReturnType<typeof execution>["run"]): Promise<PreparedEvidenceHelperReceipt> => {
  const store = await initializePreparedEvidenceHelperAuthorityStore(input.privateRoot);
  await hook(input.testHooks?.beforeReserve);
  const pending = await store.reserve(key, newPreparedEvidenceHelperPendingRecord({
    base_config_digest: facts.baseConfig, base_image: baseImage, context: input.context,
    daemon_digest: facts.daemonDigest, endpoint_digest: facts.endpointDigest, platform: facts.platform,
    recipe_digest: recipe.recipeDigest }));
  await hook(input.testHooks?.afterReserve);
  if (!matching(pending, baseImage, facts, recipe)) return fail();
  const authority = await store.load(key); if (!authority) return fail();
  if (authority.completion) {
    let observed = await inspectMaybe(run, authority.completion.accepted_image_config_digest, facts);
    if (observed === null) observed = await build(input, run, facts, recipe);
    if (observed !== authority.completion.accepted_image_config_digest) return fail();
    await hook(input.testHooks?.beforeReceipt); return authority.completion.receipt;
  }
  const produced = await build(input, run, facts, recipe);
  await hook(input.testHooks?.beforeComplete);
  const completion = await store.complete(key, newPreparedEvidenceHelperCompletionRecord(pending, produced));
  await hook(input.testHooks?.afterComplete);
  if (completion.accepted_image_config_digest !== produced) return fail();
  await hook(input.testHooks?.beforeReceipt); return completion.receipt;
};

/** Re-attests a completion-bound local config identity or rebuilds an absent exact config. */
export const prepareEvidenceExportHelper = async (
  input: PrepareEvidenceHelperInput,
): Promise<PreparedEvidenceHelperReceipt> => {
  const targetTimeout = timeout(input.timeoutMs); const baseImage = parseDockerBaseImageReference(input.baseImage) ?? fail();
  const run = execution(input, targetTimeout).run; const recipe = await loadLocalEvidenceHelperRecipe();
  const facts = await localFacts(run, input.context, baseImage);
  const key = createPreparedEvidenceHelperKey({ baseConfigDigest: facts.baseConfig, context: input.context,
    daemonDigest: facts.daemonDigest, endpointDigest: facts.endpointDigest, platform: facts.platform,
    recipeDigest: recipe.recipeDigest });
  const mapKey = `${input.privateRoot}\0${key}`; const joined = live.get(mapKey);
  if (joined) return joined;
  const promise = receiptOwner(input, baseImage, facts, recipe, key, run);
  live.set(mapKey, promise);
  try { return await promise; } finally { if (live.get(mapKey) === promise) live.delete(mapKey); }
};

/** Private target lowering resolves the config digest only after receipt-correlated reattestation. */
export const resolvePreparedEvidenceHelperImage = async (input: PrepareEvidenceHelperInput,
  receipt: PreparedEvidenceHelperReceipt): Promise<{ readonly configDigest: `sha256:${string}`; readonly imageReference: string }> => {
  const actual = await prepareEvidenceExportHelper(input);
  if (actual.handle !== receipt.handle || actual.digest !== receipt.digest) return fail();
  const baseImage = parseDockerBaseImageReference(input.baseImage) ?? fail();
  const run = execution(input, timeout(input.timeoutMs)).run;
  const facts = await localFacts(run, input.context, baseImage);
  const recipe = await loadLocalEvidenceHelperRecipe(); const store = await initializePreparedEvidenceHelperAuthorityStore(input.privateRoot);
  const key = createPreparedEvidenceHelperKey({ baseConfigDigest: facts.baseConfig, context: input.context,
    daemonDigest: facts.daemonDigest, endpointDigest: facts.endpointDigest, platform: facts.platform,
    recipeDigest: recipe.recipeDigest });
  const authority: PreparedEvidenceHelperAuthority | null = await store.load(key);
  if (!authority?.completion || authority.completion.receipt.handle !== receipt.handle
    || authority.completion.receipt.digest !== receipt.digest) return fail();
  return Object.freeze({ configDigest: authority.completion.accepted_image_config_digest,
    imageReference: authority.completion.accepted_image_config_digest });
};
