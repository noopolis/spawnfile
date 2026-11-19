import { z } from "zod";
import { parseImageReference } from "../distribution/imageRef.js";
import { SpawnfileError } from "../shared/index.js";
import type { RuntimeRegistryInstall } from "./registry.js";
import type { RuntimeAdapter } from "./types.js";

export const RUNTIME_ADAPTER_API_VERSION = 1;

export interface RuntimeAdapterCatalog {
  defaultBranch: string;
  ref: string;
  remote: string;
  install?: RuntimeRegistryInstall;
  status?: "active" | "deprecated";
}

export interface RuntimeAdapterPlugin {
  apiVersion: typeof RUNTIME_ADAPTER_API_VERSION;
  adapter: RuntimeAdapter;
  catalog: RuntimeAdapterCatalog;
}

export const defineRuntimeAdapterPlugin = (plugin: RuntimeAdapterPlugin): RuntimeAdapterPlugin => plugin;

const text = z.string().trim().min(1);
const npmPackageName = text.max(214).regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u);
const npmVersion = text.regex(/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const catalogSchema = z.strictObject({
  defaultBranch: text,
  ref: text,
  remote: text,
  status: z.enum(["active", "deprecated"]).optional(),
  install: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("container_image"), image: text, tag: text, digest: digest.optional(),
      contractManifestSha256: digest.optional(),
      capabilityReceipt: digest.optional(),
      capabilityReceipts: z.strictObject({ amd64: digest.optional(), arm64: digest.optional() })
        .refine((value) => Boolean(value.amd64 || value.arm64)).optional()
    }).refine((value) => !(value.capabilityReceipt && value.capabilityReceipts))
      .refine(({ image, tag }) => parseImageReference(`${image}:${tag}`)?.tag === tag,
        { message: "expected an image name and separate tag", path: ["image"] }),
    z.strictObject({ kind: z.literal("npm"), package: npmPackageName, version: npmVersion }),
    z.strictObject({
      kind: z.literal("github_release_archive"), repository: text, tag: text, binary: text,
      assets: z.record(z.string(), text)
    }),
    z.strictObject({ kind: z.literal("source_repo") })
  ]).optional()
});

const containerSchema = z.object({
  configFileName: text,
  rawHomeAuthImports: z.array(z.enum(["claude-code", "codex"])).optional(),
  standaloneBaseImage: text.refine((image) => parseImageReference(image) !== null),
  instancePaths: z.object({
    configPathTemplate: text,
    workspacePathTemplate: text
  }),
  startCommand: z.array(text).nonempty(),
  systemDeps: z.array(text)
});
const hintSchema = z.object({ ecosystem: z.enum(["node", "go"]), installHint: text });
const hintsSchema = z.object({
  container_image: hintSchema,
  npm: hintSchema,
  github_release_archive: hintSchema,
  source_repo: hintSchema
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const invalidHooks = (
  value: unknown,
  path: string,
  required: string[],
  optional: string[]
): string | undefined => {
  if (!record(value)) return path;
  const bad = required.find((key) => typeof value[key] !== "function")
    ?? optional.find((key) => value[key] !== undefined && typeof value[key] !== "function");
  return bad === undefined ? undefined : `${path}.${bad}`;
};

const invalidOptionalHook = (adapter: Record<string, unknown>): string | undefined => {
  const adapterHook = invalidHooks(adapter, "adapter", [], [
    "assertSupportedSurfaces", "compileTeam", "createContainerTargets", "preflightAgent",
    "prepareRuntimeAuth", "scaffoldAgentProject", "validateRuntimeOptions"
  ]);
  if (adapterHook) return adapterHook;
  if (record(adapter.training)) {
    const { login, credentials } = adapter.training;
    if (login !== undefined) {
      const badLogin = invalidHooks(login, "training.login", ["supportsEngine", "run"], []);
      if (badLogin) return badLogin;
    }
    if (credentials !== undefined && (!record(credentials) || Object.values(credentials).some((load) => typeof load !== "function"))) {
      return "training.credentials";
    }
  }
  const capabilities = [
    { name: "training", required: [], optional: ["subject", "run", "openJudges", "loadInferenceProviders", "loadGraderProviders"] },
    { name: "host", required: [], optional: [
      "handlesImageModelAuth", "externalMountEnvironment", "profileVolumeName", "projectSecurityArgs",
      "prepareCredentialDocker", "prepareImageLaunch", "prepareImageAuth", "localImageReport"
    ] },
    { name: "wiring", required: [], optional: ["memory"] },
    { name: "operations", required: [], optional: ["exportFiles", "privateExportDirectories"] },
    { name: "systemInstructionSurface", required: ["resolvePath"], optional: [] }
  ];
  for (const { name, required, optional } of capabilities) {
    if (adapter[name] === undefined) continue;
    const invalid = invalidHooks(adapter[name], `adapter.${name}`, required, optional);
    if (invalid) return invalid;
  }

  const nested = [
    { parent: "host", name: "entrypoint", required: ["rootfsFiles"], optional: ["finalizeInstall", "healthcheck", "stateOwnership"] },
    { parent: "wiring", name: "moltnet", required: ["bridge"], optional: [] },
    { parent: "operations", name: "drain", required: ["drain", "resume", "availability"], optional: [] },
    { parent: "operations", name: "readiness", required: ["compileEvidence", "validateReceipt"], optional: [] },
    { parent: "operations", name: "recording", required: ["assertSupported", "facts"], optional: [] },
    { parent: "operations", name: "usage", required: ["parse"], optional: ["matchesLegacyInstance"] }
  ];
  for (const { parent, name, required, optional } of nested) {
    const capability = adapter[parent];
    if (!record(capability) || capability[name] === undefined) continue;
    const invalid = invalidHooks(capability[name], `adapter.${parent}.${name}`, required, optional);
    if (invalid) return invalid;
  }

  if (record(adapter.operations) && record(adapter.operations.recording)) {
    const { reader } = adapter.operations.recording;
    if (reader !== undefined) {
      const path = "adapter.operations.recording.reader";
      const invalid = invalidHooks(reader, path, ["wakeRowsPath", "createWakeMomentsParser", "readJsonl"], []);
      if (invalid) return invalid;
      if (!record(reader) || !text.safeParse(reader.format).success) return `${path}.format`;
    }
  }

  if (adapter.statusProbes !== undefined &&
    (!Array.isArray(adapter.statusProbes) || adapter.statusProbes.some((probe: unknown) => invalidHooks(probe, "statusProbes", ["run"], [])))) {
    return "adapter.statusProbes";
  }
  return undefined;
};

export const validateRuntimeAdapterPlugin = (value: unknown, source: string): RuntimeAdapterPlugin => {
  const fail = (message: string): never => {
    throw new SpawnfileError("validation_error", `Adapter ${source}: ${message}`);
  };
  if (!record(value)) return fail("expected a named spawnfileAdapter export");
  if (value.apiVersion !== RUNTIME_ADAPTER_API_VERSION) {
    return fail(`unsupported apiVersion ${String(value.apiVersion)} (expected ${RUNTIME_ADAPTER_API_VERSION})`);
  }
  const adapter = value.adapter;
  if (!record(adapter) || typeof adapter.name !== "string" || !/^[a-z][a-z0-9-]*$/u.test(adapter.name)) {
    return fail("expected a lowercase adapter name (letters, digits, hyphens)");
  }
  if (typeof adapter.assertSupportedModelTarget !== "function" || typeof adapter.compileAgent !== "function"
    || !containerSchema.safeParse(adapter.container).success) {
    return fail("invalid adapter implementation: expected container settings, assertSupportedModelTarget and compileAgent");
  }
  if (!record(adapter.install) || typeof adapter.install.createRecipe !== "function"
    || !hintsSchema.safeParse(adapter.install.hints).success) {
    return fail("invalid install implementation: expected install hints and createRecipe");
  }
  const badHook = invalidOptionalHook(adapter);
  if (badHook) return fail(`invalid optional hook or capability: ${badHook}`);
  const catalog = catalogSchema.safeParse(value.catalog);
  if (!catalog.success) return fail(`invalid catalog at ${catalog.error.issues[0]?.path.join(".") || "root"}`);
  // Preserve prototype methods and their receiver, including private fields.
  return { apiVersion: RUNTIME_ADAPTER_API_VERSION, adapter: adapter as unknown as RuntimeAdapter, catalog: catalog.data };
};
