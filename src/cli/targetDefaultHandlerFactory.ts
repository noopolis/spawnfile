import { types as nodeTypes } from "node:util";

import { createDockerCleanupRunOperations } from "../target/cleanupRunDocker.js";
import { createDockerArtifactOperations } from "../target/dockerArtifacts.js";
import { createDockerPreparedArtifactOperations } from "../target/dockerPreparedArtifact.js";
import { initializeFilesystemTargetLocalBundleStore } from "../target/containerBundleFilesystemStore.js";
import { createDockerTargetLocalBundleBuilder } from "../target/dockerContainerBundleBuilder.js";
import { createDockerResourceOperations } from "../target/dockerResources.js";
import { createDockerSecretOperations } from "../target/dockerSecrets.js";
import { selectTarget, type SelectTargetOptions } from "../target/dockerTarget.js";
import { createDockerWorldServiceOperations } from "../target/dockerWorldService.js";
import { createEvidenceExportOperations } from "../target/evidenceExport.js";
import { createEvidenceExportHelper, EVIDENCE_EXPORT_HELPER_CONTRACT } from "../target/evidenceExportProvider.js";
import { resolvePreparedEvidenceHelperImage } from "../evidenceExportHelper/index.js";
import { createDockerOrganizationAttachmentOperations } from "../target/organizationAttachment.js";
import type { SelectedTargetReceipt, TargetResourceRequest } from "../target/contracts.js";

import type { TargetDefaultAuthorities } from "./targetDefaultAuthorities.js";
import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import { createTargetEvidenceHelperResolutionRequest } from "./targetEvidenceHelperResolution.js";
import type { TargetCommandHandlers } from "./targetCommands.js";

type Result = Awaited<ReturnType<TargetCommandHandlers["cleanup_run"]>>;
interface Operations {
  execute(raw: unknown): Promise<Result>;
}
interface EvidenceOperations {
  recover(raw: unknown, destination: unknown): Promise<Result>;
  execute(raw: unknown, destination: unknown): Promise<Result>;
}
type Factory = (options: Record<string, unknown>) => Operations;
type EvidenceFactory = (options: Record<string, unknown>) => EvidenceOperations;

export interface TargetDefaultHandlerFactories {
  readonly artifact: Factory;
  readonly attachment: Factory;
  readonly cleanup: Factory;
  readonly evidence: EvidenceFactory;
  readonly resource: Factory;
  readonly secret: Factory;
  readonly select: (options: SelectTargetOptions) => Promise<SelectedTargetReceipt>;
  readonly world: Factory;
}

export const targetDefaultHandlerFactories: TargetDefaultHandlerFactories = Object.freeze({
  artifact: createDockerArtifactOperations as unknown as Factory,
  attachment: createDockerOrganizationAttachmentOperations as unknown as Factory,
  cleanup: createDockerCleanupRunOperations as unknown as Factory,
  evidence: createEvidenceExportOperations as unknown as EvidenceFactory,
  resource: createDockerResourceOperations as unknown as Factory,
  secret: createDockerSecretOperations as unknown as Factory,
  select: selectTarget,
  world: createDockerWorldServiceOperations as unknown as Factory
});

const MUTATIONS = Object.freeze([
  "attach_organization",
  "cleanup_run",
  "create_data_network",
  "create_evidence_volume",
  "create_world_service",
  "detach_organization",
  "export_evidence_volume",
  "prepare_secret_bindings",
  "recover_operation",
  "resolve_world_artifact",
  "revoke_secret_bindings",
  "start_world_service",
  "stop_world_service"
] as const);
type MutationOperation = typeof MUTATIONS[number];
type MutationRequest = Extract<TargetResourceRequest, { operation: MutationOperation }>;

const shape = (raw: unknown, expected: readonly string[]): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new Error("Target handler initialization failed");
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    throw new Error("Target handler initialization failed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some((descriptor) =>
    !descriptor.enumerable || !("value" in descriptor))) {
    throw new Error("Target handler initialization failed");
  }
  return Object.fromEntries(expected.map((key) => [key, descriptors[key]!.value]));
};

const requireFactories = (
  raw: TargetDefaultHandlerFactories
): TargetDefaultHandlerFactories => {
  const names = [
    "artifact", "attachment", "cleanup", "evidence",
    "resource", "secret", "select", "world"
  ] as const;
  const values = shape(raw, names);
  for (const name of names) {
    if (typeof values[name] !== "function") throw new Error("Target handler initialization failed");
  }
  return Object.freeze(values) as unknown as TargetDefaultHandlerFactories;
};

const requireAuthorities = (raw: TargetDefaultAuthorities): TargetDefaultAuthorities => {
  const names = [
    "artifactIdentityStore", "attachmentAuthorityStore",
    "evidenceExportAuthorityStore", "executors", "handoffResolver",
    "helperArtifactResolver", "helperExecutor", "journals", "secretAuthorityStore",
    "secretResolver", "topologyAttestor", "worldAuthorityStore", "worldResolver"
  ] as const;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new Error("Target handler initialization failed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = shape(raw, Object.hasOwn(descriptors, "helperArtifactResolver")
    ? names : names.filter((name) => name !== "helperArtifactResolver"));
  for (const name of [
    "artifactIdentityStore", "attachmentAuthorityStore",
    "evidenceExportAuthorityStore", "secretAuthorityStore", "worldAuthorityStore"
  ] as const) {
    if (!values[name] || typeof values[name] !== "object") {
      throw new Error("Target handler initialization failed");
    }
  }
  const executorNames = [
    "artifact", "attachment", "evidenceExport", "publicArtifact", "resource",
    "secret", "world"
  ] as const;
  const executors = shape(values.executors, executorNames);
  if (executorNames.some((name) => typeof executors[name] !== "function")) {
    throw new Error("Target handler initialization failed");
  }
  if (typeof values.helperExecutor !== "function") {
    throw new Error("Target handler initialization failed");
  }
  for (const name of [
    "handoffResolver", "journals", "secretResolver", "worldResolver"
  ] as const) {
    const resolver = shape(values[name], ["resolve"]);
    if (typeof resolver.resolve !== "function") {
      throw new Error("Target handler initialization failed");
    }
  }
  if (values.helperArtifactResolver !== undefined) {
    const resolver = shape(values.helperArtifactResolver, ["resolve"]);
    if (typeof resolver.resolve !== "function") {
      throw new Error("Target handler initialization failed");
    }
  }
  const topologyAttestor = shape(values.topologyAttestor, ["activate", "attest"]);
  if (typeof topologyAttestor.activate !== "function"
    || typeof topologyAttestor.attest !== "function") {
    throw new Error("Target handler initialization failed");
  }
  return Object.freeze({ ...values, executors: Object.freeze(executors) }) as unknown as TargetDefaultAuthorities;
};

const execute = async (
  expected: MutationOperation,
  factories: TargetDefaultHandlerFactories,
  authorities: TargetDefaultAuthorities,
  config: TargetDefaultConfig,
  raw: MutationRequest
): Promise<Result> => {
  if (!raw || raw.operation !== expected) throw new Error("Target operation mismatch");
  const authority = await authorities.journals.resolve({ context: config.context, request: raw });
  const request = authority.request;
  if (request.operation !== expected) throw new Error("Target operation mismatch");
  const common = { context: config.context, journal: authority.journal, timeoutMs: config.timeoutMs };
  const run = async (): Promise<Result> => {
    switch (request.operation) {
    case "resolve_world_artifact": {
      const prepared = config.preparedArtifactMappings.filter((mapping) =>
        mapping.artifact_manifest_digest === request.artifact_manifest_digest);
      if (prepared.length > 1) throw new Error("Target operation mismatch");
      if (prepared.length === 1) {
        return createDockerPreparedArtifactOperations({
          builder: createDockerTargetLocalBundleBuilder({
            context: config.context,
            executor: authorities.executors.artifact,
            timeoutMs: config.timeoutMs
          }),
          identityStore: authorities.artifactIdentityStore,
          journal: authority.journal,
          mapping: prepared[0]!,
          store: await initializeFilesystemTargetLocalBundleStore(config.paths.containerBundles)
        }).execute(request);
      }
      return factories.artifact({
        ...common,
        executor: authorities.executors.artifact,
        identityStore: authorities.artifactIdentityStore,
        mappings: config.artifactMappings
      }).execute(request);
    }
    case "prepare_secret_bindings":
    case "revoke_secret_bindings":
      return factories.secret({
        ...common,
        authorityStore: authorities.secretAuthorityStore,
        executor: authorities.executors.secret,
        resolver: authorities.secretResolver
      }).execute(request);
    case "create_data_network":
    case "create_evidence_volume":
      return factories.resource({ ...common, executor: authorities.executors.resource }).execute(request);
    case "attach_organization":
    case "detach_organization":
      return factories.attachment({
        ...common,
        authorityStore: authorities.attachmentAuthorityStore,
        executor: authorities.executors.attachment,
        resolver: authorities.handoffResolver
      }).execute(request);
    case "create_world_service":
    case "start_world_service":
    case "stop_world_service":
      return factories.world({
        ...common,
        authorityStore: authorities.worldAuthorityStore,
        executor: authorities.executors.world,
        resolver: authorities.worldResolver
      }).execute(request);
    case "export_evidence_volume":
    case "recover_operation": {
      if (config.evidenceHelperBaseImage && config.preparedEvidenceHelper) {
        const helperInput = { baseImage: config.evidenceHelperBaseImage, context: config.context,
          executor: authorities.helperExecutor, privateRoot: config.paths.evidenceHelper,
          timeoutMs: config.timeoutMs };
        const image = await resolvePreparedEvidenceHelperImage(helperInput, config.preparedEvidenceHelper);
        const localHelper = createEvidenceExportHelper({ artifactManifestDigest: config.preparedEvidenceHelper.digest,
          imageDigest: image.configDigest, imageReference: image.imageReference, resultHandle: config.preparedEvidenceHelper.handle });
        const operations = factories.evidence({
          ...common, artifactIdentityStore: authorities.artifactIdentityStore,
          authorityStore: authorities.evidenceExportAuthorityStore, executor: authorities.executors.resource,
          exportExecutor: authorities.executors.evidenceExport, helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT,
          helperArtifactManifestDigest: config.preparedEvidenceHelper.digest, localHelper
        });
        return request.operation === "recover_operation"
          ? operations.recover(request, config.evidenceDestination)
          : operations.execute(request, config.evidenceDestination);
      }
      if (!config.helperArtifact || !authorities.helperArtifactResolver) {
        throw new Error("Target evidence helper is not configured");
      }
      if (request.operation === "export_evidence_volume") {
        await factories.artifact({
          ...common,
          executor: authorities.executors.artifact,
          identityStore: authorities.artifactIdentityStore,
          mappings: config.artifactMappings
        }).execute(createTargetEvidenceHelperResolutionRequest(
          request,
          config.helperArtifact.artifact_manifest_digest
        ));
      }
      const helper = await authorities.helperArtifactResolver.resolve({
        context: config.context,
        request
      });
      const operations = factories.evidence({
        ...common,
        artifactIdentityStore: authorities.artifactIdentityStore,
        authorityStore: authorities.evidenceExportAuthorityStore,
        executor: authorities.executors.resource,
        exportExecutor: authorities.executors.evidenceExport,
        helperArtifactBundle: helper.bundle,
        helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT,
        helperArtifactManifestDigest: config.helperArtifact.artifact_manifest_digest
      });
      return request.operation === "recover_operation"
        ? operations.recover(request, config.evidenceDestination)
        : operations.execute(request, config.evidenceDestination);
    }
    case "cleanup_run":
      return factories.cleanup({
        ...common,
        attachmentExecutor: authorities.executors.attachment,
        attachmentStore: authorities.attachmentAuthorityStore,
        evidenceExportStore: authorities.evidenceExportAuthorityStore,
        resourceExecutor: authorities.executors.resource,
        secretExecutor: authorities.executors.secret,
        worldExecutor: authorities.executors.world,
        worldStore: authorities.worldAuthorityStore
      }).execute(request);
    }
  };
  return authority.journal.withLifecycleLease(run);
};

export const createTargetDefaultHandlers = async (
  config: TargetDefaultConfig,
  rawFactories: TargetDefaultHandlerFactories,
  rawAuthorities: TargetDefaultAuthorities
): Promise<TargetCommandHandlers> => {
  const factories = requireFactories(rawFactories);
  const authorities = requireAuthorities(rawAuthorities);
  const handlers = Object.fromEntries(MUTATIONS.map((operation) => [
    operation,
    (request: MutationRequest) => execute(operation, factories, authorities, config, request)
  ])) as unknown as Omit<TargetCommandHandlers, "select_target">;
  return Object.freeze({
    ...handlers,
    select_target: async (request: Extract<TargetResourceRequest, { operation: "select_target" }>) => {
      if (request.target_reference !== config.context) throw new Error("Target selection failed");
      return factories.select({
        context: config.context,
        dockerCommand: config.dockerCommand,
        execFile: async (_file, args, options) =>
          authorities.executors.resource("docker", args, options),
        timeoutMs: config.timeoutMs
      });
    }
  });
};
