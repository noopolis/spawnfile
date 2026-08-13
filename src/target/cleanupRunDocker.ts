import { SpawnfileError } from "../shared/index.js";
import {
  createCleanupRunOperations,
  type CleanupRunOperations
} from "./cleanupRun.js";
import {
  prepareDockerCleanupRun,
  type DockerCleanupRunPreflightOptions
} from "./cleanupRunDockerPreflight.js";
import {
  cleanupExactDockerSecretBindings
} from "./dockerSecretsLifecycle.js";
import { type DockerSecretExecutor } from "./dockerSecretsProvider.js";
import {
  proveExactDockerResourcePresent,
  removeExactDockerResource
} from "./dockerResources.js";
import {
  type DockerResourceExecutor,
  type DockerResourceSpec
} from "./dockerResourcesProvider.js";
import {
  removeExactDockerWorldService
} from "./dockerWorldServiceLifecycle.js";
import { type DockerWorldServiceExecutor } from "./dockerWorldServiceProvider.js";
import {
  detachExactOrganizationAttachment
} from "./organizationAttachmentLifecycle.js";
import { type DockerOrganizationAttachmentExecutor } from "./organizationAttachmentProvider.js";

const CLEANUP_ERROR = "Target cleanup failed";
const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;

export interface DockerCleanupRunOptions extends DockerCleanupRunPreflightOptions {
  readonly attachmentExecutor: DockerOrganizationAttachmentExecutor;
  readonly context: string;
  readonly resourceExecutor: DockerResourceExecutor;
  readonly secretExecutor: DockerSecretExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly worldExecutor: DockerWorldServiceExecutor;
}

const fail = (): never => {
  throw new SpawnfileError("runtime_error", CLEANUP_ERROR);
};
const validateOptions = (raw: DockerCleanupRunOptions): DockerCleanupRunOptions => {
  if (!raw || typeof raw.context !== "string" || !CONTEXT.test(raw.context)
    || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1
    || raw.timeoutMs > 120_000 || typeof raw.attachmentExecutor !== "function"
    || typeof raw.resourceExecutor !== "function"
    || typeof raw.secretExecutor !== "function"
    || typeof raw.worldExecutor !== "function" || !raw.journal
    || typeof raw.journal.read !== "function"
    || typeof raw.journal.resolveCompletedReceipt !== "function"
    || !raw.attachmentStore
    || typeof raw.attachmentStore.loadAttachment !== "function"
    || !raw.worldStore || typeof raw.worldStore.loadService !== "function"
    || !raw.evidenceExportStore
    || typeof raw.evidenceExportStore.loadAdmission !== "function"
    || typeof raw.evidenceExportStore.loadIndex !== "function") return fail();
  return raw;
};

export const createDockerCleanupRunOperations = (
  rawOptions: DockerCleanupRunOptions
): CleanupRunOperations => {
  const options = validateOptions(rawOptions);
  const resourceOptions = {
    context: options.context,
    executor: options.resourceExecutor,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  };
  return createCleanupRunOperations({
    journal: options.journal,
    prepare: async ({ request }) => prepareDockerCleanupRun(request, options),
    steps: {
      detachAttachment: async ({ authority }) =>
        detachExactOrganizationAttachment(authority, {
          context: options.context,
          executor: options.attachmentExecutor,
          signal: options.signal,
          timeoutMs: options.timeoutMs
        }),
      preserveEvidence: async ({ authority }) =>
        proveExactDockerResourcePresent(authority as DockerResourceSpec, resourceOptions),
      removeDataNetwork: async ({ authority }) =>
        removeExactDockerResource(authority as DockerResourceSpec, resourceOptions),
      removeEvidence: async ({ authority }) =>
        removeExactDockerResource(authority as DockerResourceSpec, resourceOptions),
      removeSecrets: async ({ authority }) =>
        cleanupExactDockerSecretBindings(authority, {
          context: options.context,
          executor: options.secretExecutor,
          signal: options.signal,
          timeoutMs: options.timeoutMs
        }),
      removeWorld: async ({ authority }) =>
        removeExactDockerWorldService(authority, {
          context: options.context,
          executor: options.worldExecutor,
          signal: options.signal,
          timeoutMs: options.timeoutMs
        })
    }
  });
};
