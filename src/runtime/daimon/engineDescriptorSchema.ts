import { z } from "zod";

import { DAIMON_V5_ENGINE_DESCRIPTORS } from "./engineDescriptors.generated.js";
import { SpawnfileError } from "../../shared/errors.js";

/** Published broker/realm ABIs are closed; engine identities are extensible. */
const literalDataSchema = (value: unknown): z.ZodType => {
  if (value === null) return z.null();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return z.literal(value);
  if (Array.isArray(value)) return z.tuple(value.map(literalDataSchema) as [z.ZodType, ...z.ZodType[]]);
  if (typeof value !== "object" || !value) throw new Error("Non-JSON descriptor contract");
  return z.strictObject(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, literalDataSchema(entry)])));
};

const pinned = Object.values(DAIMON_V5_ENGINE_DESCRIPTORS);
export const DAIMON_PINNED_BROKER_DESCRIPTOR = pinned.find((entry): entry is Extract<typeof pinned[number], { broker: object }> => entry.broker !== null)!;
export const DAIMON_PINNED_PORTABLE_DESCRIPTOR = pinned.find((entry): entry is Extract<typeof pinned[number], { auth: { staging: "portable-file" | "portable-realm" } }> => entry.auth.staging !== "secret-service" && entry.broker === null)!;
export const DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR = pinned.find((entry): entry is Extract<typeof pinned[number], { auth: { staging: "secret-service" } }> => entry.auth.staging === "secret-service")!;
export type DaimonEngineBroker = typeof DAIMON_PINNED_BROKER_DESCRIPTOR.broker;

const nonblank = z.string().min(1).max(4096).regex(/\S/u);
const identifier = z.string().regex(/^[a-z][a-z0-9-]*$/u).max(128);
const relativePath = nonblank.refine((value) => !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "." || !part));
const environmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
const credential = z.strictObject({
  destinationRelativePath: relativePath, sourceSlot: identifier.optional(), sourceRelativePath: relativePath.optional(),
  directoryMode: z.literal(0o700).optional(), fileMode: z.literal(0o600).optional()
});
const format = z.strictObject({
  containerKey: nonblank.optional(), fallbackToRoot: z.boolean().optional(), entryKeyPattern: nonblank.optional(),
  accessTokenKeys: z.array(nonblank).min(1), refreshTokenKeys: z.array(nonblank).min(1), expiresAtKey: nonblank.optional()
});
const fileAuth = {
  method: nonblank, provider: nonblank, fileName: relativePath,
  maxCredentialBytes: z.number().int().positive().max(1_048_576), directoryMode: z.literal(0o700), fileMode: z.literal(0o600), format
};
const auth = z.discriminatedUnion("staging", [
  z.strictObject({ ...fileAuth, staging: z.literal("portable-file"), realm: z.null() }),
  z.strictObject({ ...fileAuth, staging: z.literal("portable-realm"), realm: literalDataSchema(DAIMON_PINNED_PORTABLE_DESCRIPTOR.auth.realm) as z.ZodType<NonNullable<typeof DAIMON_PINNED_PORTABLE_DESCRIPTOR.auth.realm>> }),
  z.strictObject({ ...fileAuth, staging: z.literal("broker-realm"), realm: literalDataSchema(DAIMON_PINNED_BROKER_DESCRIPTOR.auth.realm) as z.ZodType<typeof DAIMON_PINNED_BROKER_DESCRIPTOR.auth.realm> }),
  z.strictObject({ staging: z.literal("secret-service"), method: z.null(), provider: z.null(),
    realm: literalDataSchema(DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR.auth.realm) as z.ZodType<typeof DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR.auth.realm>, busEnvironment: environmentName, format: z.null() })
]);
const sandbox = z.strictObject({
  configurable: z.boolean(),
  policy: z.strictObject({ mode: z.literal("workspace-write"), networkAccess: z.literal(false), webSearch: z.literal("disabled") }).optional(),
  profile: nonblank.optional(), baseProfile: nonblank.optional(), restrictNetwork: z.boolean().optional(),
  denyPaths: z.strictObject({ canonicalAbsolute: z.boolean(), rootAllowed: z.boolean(), trailingSlashAllowed: z.boolean(), forbiddenCharacterPattern: nonblank }).optional()
});
export const daimonEngineDescriptorSchema = z.strictObject({
  id: identifier, authKinds: z.array(nonblank).min(1), auth, credentialMaterial: credential.nullable(),
  piAuthMethod: nonblank.optional(), piProvider: nonblank.optional(), piSourceProvider: nonblank.optional(),
  homeDirectory: z.union([z.literal(""), relativePath]), homeEnvironment: environmentName,
  requiredBinaries: z.array(identifier).min(1),
  modelSelection: z.strictObject({
    configurable: z.boolean(), models: z.union([z.strictObject({ kind: z.literal("non-empty-string") }), z.strictObject({ kind: z.literal("enum"), values: z.array(nonblank).min(1) }), z.null()]),
    reasoningEfforts: z.array(nonblank), defaults: z.strictObject({ model: nonblank.nullable(), reasoningEffort: nonblank.nullable() }),
    requiresPairedDeclaration: z.boolean(), declarationRequiresBroker: z.boolean()
  }),
  sandbox,
  training: z.strictObject({
    subject: z.discriminatedUnion("supported", [
      z.strictObject({ supported: z.literal(true), isolation: z.enum(["native-sandbox", "broker-worker"]) }),
      z.strictObject({ supported: z.literal(false), isolation: z.null(), reason: nonblank })
    ]),
    inferenceGrants: (literalDataSchema(DAIMON_PINNED_BROKER_DESCRIPTOR.training.inferenceGrants) as z.ZodType<typeof DAIMON_PINNED_BROKER_DESCRIPTOR.training.inferenceGrants>).nullable()
  }),
  broker: (literalDataSchema(DAIMON_PINNED_BROKER_DESCRIPTOR.broker) as z.ZodType<DaimonEngineBroker>).nullable(),
  capabilities: z.strictObject({ portableCredential: z.boolean(), nativeSandbox: z.boolean(), broker: z.boolean(), secretService: z.boolean() })
});
export type DaimonEngineDescriptor = z.infer<typeof daimonEngineDescriptorSchema>;
export type DaimonEngineDescriptors = Readonly<Record<string, DaimonEngineDescriptor>>;
export const daimonEngineDescriptorsSchema = z.record(identifier, daimonEngineDescriptorSchema);
const brokerSandboxSchema = literalDataSchema(DAIMON_PINNED_BROKER_DESCRIPTOR.sandbox);

/** Cross-field relationships are checked separately so JSON Schema stays portable. */
export const parseDaimonEngineDescriptors = (value: unknown): DaimonEngineDescriptors => {
  const result = daimonEngineDescriptorsSchema.safeParse(value);
  const fail = (): never => { throw new SpawnfileError("runtime_error", "Daimon runtime contract manifest has invalid engines descriptors"); };
  if (!result.success || Object.keys(result.data).length === 0) return fail();
  for (const [id, descriptor] of Object.entries(result.data)) {
    const { auth, broker, capabilities, credentialMaterial, modelSelection: selection, training, sandbox } = descriptor;
    if (id !== descriptor.id || capabilities.broker !== (broker !== null)
      || capabilities.secretService !== (auth.staging === "secret-service")
      || capabilities.portableCredential !== (auth.staging !== "secret-service")
      || (auth.staging === "broker-realm") !== (broker !== null)
      || (auth.staging === "portable-file" && (!credentialMaterial?.sourceSlot || !credentialMaterial.sourceRelativePath || credentialMaterial.directoryMode !== auth.directoryMode || credentialMaterial.fileMode !== auth.fileMode))
      || (auth.staging === "secret-service" && credentialMaterial !== null)
      || (auth.staging === "broker-realm" && credentialMaterial?.destinationRelativePath !== auth.realm.agentCredentialRelativePath)
      || (auth.staging === "portable-realm" && (credentialMaterial?.destinationRelativePath !== auth.realm.agentCredentialRelativePath || credentialMaterial?.sourceSlot !== auth.realm.bootstrapSourceSlot))
      || (selection.declarationRequiresBroker && broker === null)
      || (broker !== null && (selection.models?.kind !== "enum"
        || JSON.stringify(selection.models.values) !== JSON.stringify(broker.worker.models)
        || JSON.stringify(selection.reasoningEfforts) !== JSON.stringify(broker.worker.reasoningEfforts)))
      || (broker !== null && !brokerSandboxSchema.safeParse(sandbox).success)
      || (!selection.configurable && (selection.models !== null || selection.reasoningEfforts.length !== 0))
      || (selection.defaults.model !== null && (selection.models === null || (selection.models.kind === "enum" && !selection.models.values.includes(selection.defaults.model))))
      || (selection.defaults.reasoningEffort !== null && !selection.reasoningEfforts.includes(selection.defaults.reasoningEffort))
      || (training.subject.supported && (!capabilities.nativeSandbox || (training.subject.isolation === "broker-worker" && broker === null)))) return fail();
    if (auth.staging !== "secret-service" && auth.format.entryKeyPattern) {
      try { new RegExp(auth.format.entryKeyPattern, "u"); } catch { return fail(); }
    }
  }
  return result.data;
};
