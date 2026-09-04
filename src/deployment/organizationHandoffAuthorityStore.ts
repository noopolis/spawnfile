import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { resolveSpawnfileHome } from "../auth/index.js";
import { parseOpaqueTargetHandle } from "../target/index.js";
import {
  ORGANIZATION_HANDOFF_AUTHORITY_ERROR, createOrganizationHandoffCapabilityPending,
  createOrganizationHandoffDockerObservation, createOrganizationHandoffHandle,
  createOrganizationHandoffRecoveryKey,
  parseOrganizationAttachmentAuthorizationForDeployment, parseOrganizationHandoffCapability,
  parseOrganizationHandoffDockerObservation,
  type OrganizationHandoffCapabilityFinalized, type OrganizationHandoffCapabilityPending,
  type OrganizationHandoffDockerObservation
} from "./organizationHandoffAuthorityTypes.js";
import { parseOrganizationHandoff, type OrganizationHandoff } from "./organizationHandoffTypes.js";
import { initializeOrganizationHandoffAuthorityFsClient, type OrganizationHandoffAuthorityFsClient, type OrganizationHandoffAuthorityFsClientOptions } from "./organizationHandoffAuthorityFsClient.js";

const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
/**
 * The store's public message stays uniform: it reaches CLI output and must not
 * describe private resolution state. Diagnostics from the helper are preserved
 * on `cause` so an operator log still shows which budget or invariant failed.
 */
const fail = (cause?: unknown): never => {
  throw new Error(ORGANIZATION_HANDOFF_AUTHORITY_ERROR, ...(cause === undefined ? [] : [{ cause }] as const));
};
const key = (value: string): string => Buffer.from(value, "utf8").toString("hex");
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const pendingKey = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : fail();
const recoveryName = (value: unknown): string => `${key(createOrganizationHandoffRecoveryKey(value))}.json`;
const closeRequest = (value: unknown): {
  readonly expectedHandoff: OrganizationHandoff;
  readonly organizationHandoffHandle: string;
} => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "expectedHandoff")
    || !Object.hasOwn(value, "organizationHandoffHandle")) return fail();
  const input = value as { expectedHandoff: unknown; organizationHandoffHandle: unknown };
  try {
    return Object.freeze({
      expectedHandoff: parseOrganizationHandoff(input.expectedHandoff),
      organizationHandoffHandle: parseOpaqueTargetHandle(input.organizationHandoffHandle)
    });
  } catch (error) {
    return fail(error);
  }
};

export const resolveOrganizationHandoffAuthorityRoot = (): string =>
  path.join(resolveSpawnfileHome(), "deployments", "organization-handoff-authority");

const checkDirectory = async (directory: string): Promise<void> => {
  const home = resolveSpawnfileHome(); const root = path.resolve(directory);
  if (root !== home && !root.startsWith(`${home}${path.sep}`)) return fail();
  await mkdir(home, { mode: 0o700, recursive: true }).catch(fail);
  const homeStat = await lstat(home).catch(fail);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || (homeStat.mode & 0o077) !== 0
    || owner !== undefined && homeStat.uid !== owner) return fail();
  let current = home;
  for (const part of path.relative(home, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let stat;
    try { stat = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
      await mkdir(current, { mode: 0o700 }).catch((mkdirError: NodeJS.ErrnoException) => {
        if (mkdirError.code !== "EEXIST") fail();
      }); stat = await lstat(current).catch(fail);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || owner !== undefined && stat.uid !== owner) return fail();
  }
};
const parse = (content: string) => {
  let value: unknown; try { value = JSON.parse(content); } catch { return fail(); }
  const parsed = parseOrganizationHandoffCapability(value);
  if (JSON.stringify(parsed) !== content) return fail();
  return parsed;
};
const parseObservation = (content: string): OrganizationHandoffDockerObservation => {
  let value: unknown; try { value = JSON.parse(content); } catch { return fail(); }
  const parsed = parseOrganizationHandoffDockerObservation(value);
  if (JSON.stringify(parsed) !== content) return fail();
  return parsed;
};

export interface OrganizationHandoffAuthorityStore {
  begin(input: Parameters<typeof createOrganizationHandoffCapabilityPending>[0]): Promise<{ readonly created: boolean; readonly pending: OrganizationHandoffCapabilityPending }>;
  close(input: { readonly expectedHandoff: unknown; readonly organizationHandoffHandle: unknown }): Promise<void>;
  dispose(): Promise<void>;
  finalize(pendingKey: unknown, container: { readonly containerId: unknown; readonly deploymentLabels: unknown }): Promise<OrganizationHandoffCapabilityFinalized>;
  observeDockerMutation(pendingKey: unknown, container: { readonly containerId: unknown; readonly deploymentLabels: unknown; readonly imageId: unknown }): Promise<OrganizationHandoffDockerObservation>;
  readDockerMutation(pendingKey: unknown): Promise<OrganizationHandoffDockerObservation | null>;
  reserve(input: Parameters<typeof createOrganizationHandoffCapabilityPending>[0]): Promise<OrganizationHandoffCapabilityPending>;
  resolver: { resolve(input: { authorization: unknown; signal?: AbortSignal }): Promise<unknown> };
}
export interface OrganizationHandoffAuthorityStoreTestHooks {
  beforeLeafOperation?(kind: "close" | "finalize" | "reserve" | "resolve"): Promise<void>;
  duringLeafOperation?(kind: "reserve", operation: () => Promise<void>): Promise<void>;
}
export interface OrganizationHandoffAuthorityStoreInitializeOptions {
  readonly testHooks?: OrganizationHandoffAuthorityStoreTestHooks;
  // Test-only failure seam. Production always uses the anchored worker client.
  readonly testInitializeFsClient?: (options: OrganizationHandoffAuthorityFsClientOptions) => Promise<OrganizationHandoffAuthorityFsClient>;
  readonly workerPath?: string;
}
interface DirectoryAnchor { readonly handle: FileHandle; readonly ino: number; readonly dev: number; }

class Store implements OrganizationHandoffAuthorityStore {
  readonly #anchors: ReadonlyMap<string, DirectoryAnchor>; readonly #clients: ReadonlyMap<string, OrganizationHandoffAuthorityFsClient>; #disposed = false; readonly #hooks: OrganizationHandoffAuthorityStoreTestHooks | undefined; readonly #root: string;
  public readonly resolver: OrganizationHandoffAuthorityStore["resolver"];
  public constructor(root: string, anchors: ReadonlyMap<string, DirectoryAnchor>, clients: ReadonlyMap<string, OrganizationHandoffAuthorityFsClient>, hooks?: OrganizationHandoffAuthorityStoreTestHooks) {
    this.#root = root;
    this.#anchors = anchors; this.#clients = clients; this.#hooks = hooks;
    this.resolver = Object.freeze({ resolve: async (input) => this.resolve(input) });
  }
  private async validateDirectories(): Promise<void> {
    if (this.#disposed) return fail();
    await Promise.all([...this.#anchors.entries()].map(async ([part, anchor]) => {
      await checkDirectory(path.join(this.#root, part)); const pathStat = await lstat(path.join(this.#root, part)).catch(fail);
      const fdStat = await anchor.handle.stat().catch(fail);
      if (pathStat.dev !== anchor.dev || pathStat.ino !== anchor.ino || fdStat.dev !== anchor.dev || fdStat.ino !== anchor.ino) fail();
    }));
  }
  public async dispose(): Promise<void> {
    if (this.#disposed) return; this.#disposed = true;
    await Promise.all([...this.#clients.values()].map(async (client) => client.dispose()));
    await Promise.all([...this.#anchors.values()].map(async ({ handle }) => { await handle.close().catch(() => undefined); }));
  }
  private client(part: string): OrganizationHandoffAuthorityFsClient { return this.#clients.get(part) ?? fail(); }
  private async hook(kind: "close" | "finalize" | "reserve" | "resolve"): Promise<void> { await this.#hooks?.beforeLeafOperation?.(kind); }
  public async reserve(input: Parameters<typeof createOrganizationHandoffCapabilityPending>[0]): Promise<OrganizationHandoffCapabilityPending> {
    await this.validateDirectories(); const pending = createOrganizationHandoffCapabilityPending(input);
    const publish = async (): Promise<void> => this.client("pending").write(`${key(pending.pending_key)}.json`, JSON.stringify(pending));
    if (this.#hooks?.duringLeafOperation) await this.#hooks.duringLeafOperation("reserve", publish);
    else { await this.hook("reserve"); await this.validateDirectories(); await publish(); }
    await this.validateDirectories(); return pending;
  }
  /**
   * Elects the one Docker mutator before Docker is invoked. Once the durable
   * reservation exists, an absent observed-id checkpoint is intentionally
   * incomplete: automatic retry could create an unprovable second container.
   */
  public async begin(input: Parameters<typeof createOrganizationHandoffCapabilityPending>[0]): Promise<{ readonly created: boolean; readonly pending: OrganizationHandoffCapabilityPending }> {
    const pending = await this.reserve(input); await this.validateDirectories(); await this.hook("reserve"); await this.validateDirectories();
    const name = recoveryName(pending.pending_key); const serialized = JSON.stringify(pending);
    const existing = await this.client("recovery-reserved").read(name);
    if (existing !== null) {
      const prior = parse(existing); if (prior.state !== "pending" || !same(prior, pending)) return fail();
      await this.validateDirectories(); return Object.freeze({ created: false, pending });
    }
    const created = await this.client("recovery-reserved").create(name, serialized);
    if (!created) {
      const prior = await this.client("recovery-reserved").read(name); if (prior === null || !same(parse(prior), pending)) return fail();
    }
    await this.validateDirectories(); return Object.freeze({ created, pending });
  }
  public async observeDockerMutation(pendingKeyRaw: unknown, container: { readonly containerId: unknown; readonly deploymentLabels: unknown; readonly imageId: unknown }): Promise<OrganizationHandoffDockerObservation> {
    await this.validateDirectories(); await this.hook("finalize"); await this.validateDirectories();
    const value = pendingKey(pendingKeyRaw); const reservation = await this.client("recovery-reserved").read(recoveryName(value));
    if (reservation === null) return fail(); const pending = parse(reservation);
    if (pending.state !== "pending" || pending.pending_key !== value) return fail();
    const observation = createOrganizationHandoffDockerObservation({ containerId: container?.containerId,
      deploymentLabels: container?.deploymentLabels, imageId: container?.imageId, pendingKey: value });
    if (!same(observation.deployment_labels, pending.deployment_labels)) return fail();
    const name = recoveryName(value); const serialized = JSON.stringify(observation);
    const existing = await this.client("recovery-docker-observed").read(name);
    if (existing !== null) {
      if (!same(parseObservation(existing), observation)) return fail();
      await this.validateDirectories(); return observation;
    }
    const created = await this.client("recovery-docker-observed").create(name, serialized);
    if (!created) {
      const prior = await this.client("recovery-docker-observed").read(name);
      if (prior === null || !same(parseObservation(prior), observation)) return fail();
    }
    await this.validateDirectories(); return observation;
  }
  public async readDockerMutation(pendingKeyRaw: unknown): Promise<OrganizationHandoffDockerObservation | null> {
    await this.validateDirectories(); await this.hook("finalize"); await this.validateDirectories();
    const value = pendingKey(pendingKeyRaw); const reservation = await this.client("recovery-reserved").read(recoveryName(value));
    if (reservation === null) return null; const pending = parse(reservation);
    if (pending.state !== "pending" || pending.pending_key !== value) return fail();
    const raw = await this.client("recovery-docker-observed").read(recoveryName(value));
    if (raw === null) return null; const observation = parseObservation(raw);
    if (observation.pending_key !== value || !same(observation.deployment_labels, pending.deployment_labels)) return fail();
    await this.validateDirectories(); return observation;
  }
  public async finalize(pendingKey: unknown, container: { readonly containerId: unknown; readonly deploymentLabels: unknown }): Promise<OrganizationHandoffCapabilityFinalized> {
    await this.validateDirectories(); await this.hook("finalize"); await this.validateDirectories();
    if (typeof pendingKey !== "string" || !/^[a-f0-9]{64}$/u.test(pendingKey) || !container) return fail();
    const source = await this.client("pending").read(`${key(pendingKey)}.json`); if (source === null) return fail();
    const pending = parse(source); if (pending.state !== "pending" || pending.pending_key !== pendingKey || !same(pending.deployment_labels, container.deploymentLabels)) return fail();
    // S3's begin path has a durable reservation leaf. Once that leaf exists,
    // finalization is allowed only from the direct inspected-id checkpoint.
    // Legacy low-level reserve/finalize callers retain their S1 behavior.
    const reserved = await this.client("recovery-reserved").read(recoveryName(pendingKey));
    if (reserved !== null) {
      if (!same(parse(reserved), pending)) return fail();
      const observed = await this.client("recovery-docker-observed").read(recoveryName(pendingKey));
      if (observed === null) return fail(); const observation = parseObservation(observed);
      if (observation.container_id !== container.containerId || !same(observation.deployment_labels, container.deploymentLabels)) return fail();
    }
    const parsed = parseOrganizationHandoffCapability({ ...pending, container_id: container.containerId,
      organization_handoff_handle: createOrganizationHandoffHandle(pending, container.containerId), state: "finalized" });
    if (parsed.state !== "finalized") return fail();
    const finalized = parsed;
    const existing = await this.client("finalized-pending").read(`${key(pending.pending_key)}.json`);
    if (existing !== null) {
      const prior = parse(existing);
      if (prior.state !== "finalized" || !same(prior, finalized)) return fail();
      await this.validateDirectories(); return finalized;
    }
    const bytes = JSON.stringify(finalized);
    await this.client("finalized").write(`${key(finalized.organization_handoff_handle)}.json`, bytes);
    await this.client("finalized-pending").write(`${key(pending.pending_key)}.json`, bytes);
    await this.validateDirectories(); return finalized;
  }
  public async close(input: { readonly expectedHandoff: unknown; readonly organizationHandoffHandle: unknown }): Promise<void> {
    await this.validateDirectories(); await this.hook("close"); await this.validateDirectories();
    const request = closeRequest(input); const content = await this.client("finalized").read(`${key(request.organizationHandoffHandle)}.json`);
    if (content === null) return fail(); const final = parse(content); if (final.state !== "finalized"
      || final.organization_handoff_handle !== request.organizationHandoffHandle
      || !same(final.handoff, request.expectedHandoff)) return fail();
    const closed = parseOrganizationHandoffCapability({ ...final, state: "attach_closed" });
    await this.client("attach-closed").write(`${key(request.organizationHandoffHandle)}.json`, JSON.stringify(closed)); await this.validateDirectories();
  }
  private async resolve(input: { authorization: unknown; signal?: AbortSignal }): Promise<unknown> {
    try {
      if (input?.signal?.aborted) return fail(); const auth = parseOrganizationAttachmentAuthorizationForDeployment(input?.authorization);
      await this.validateDirectories(); await this.hook("resolve"); await this.validateDirectories();
      if (await this.client("attach-closed").read(`${key(auth.organization_handoff_handle)}.json`) !== null) return fail();
      const content = await this.client("finalized").read(`${key(auth.organization_handoff_handle)}.json`); if (content === null) return fail();
      const final = parse(content); const pendingFinal = await this.client("finalized-pending").read(`${key(final.pending_key)}.json`);
      if (pendingFinal === null || !same(parse(pendingFinal), final) || final.state !== "finalized" || final.organization_handoff_handle !== auth.organization_handoff_handle
        || final.descriptor_digest !== auth.descriptor_digest || final.handoff.run_id !== auth.run_id
        || auth.operation_handle === final.handoff.network_attachment_handle
        || final.selected_target.handle !== auth.selected_target.handle || final.selected_target.fingerprint !== auth.selected_target.fingerprint) return fail();
      if (input.signal?.aborted) return fail(); await this.validateDirectories();
      return Object.freeze({ authorization: auth, descriptor_binding: Object.freeze({ binding_digest: final.binding_digest, descriptor_digest: final.descriptor_digest }),
        handoff: final.handoff, network_attachment: Object.freeze({ container_id: final.container_id, deployment_labels: final.deployment_labels,
          network_attachment_handle: final.handoff.network_attachment_handle }), selected_target_binding: Object.freeze({ receipt: final.selected_target,
          receipt_digest: final.selected_target_receipt_digest }) });
    } catch (error) { return fail(error); }
  }
}

export const initializeOrganizationHandoffAuthorityStore = async (options: OrganizationHandoffAuthorityStoreInitializeOptions = {}): Promise<OrganizationHandoffAuthorityStore> => {
  const root = resolveOrganizationHandoffAuthorityRoot(); const parts = ["pending", "finalized", "finalized-pending", "attach-closed", "recovery-reserved", "recovery-docker-observed"];
  await Promise.all(parts.map(async (part) => checkDirectory(path.join(root, part))));
  const anchors = new Map<string, DirectoryAnchor>();
  const clients = new Map<string, OrganizationHandoffAuthorityFsClient>();
  try {
    for (const part of parts) {
      const handle = await open(path.join(root, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(fail);
      // Register ownership before any operation that could throw, so the
      // common rollback below closes even a validation-failing descriptor.
      anchors.set(part, { handle, ino: 0, dev: 0 });
      const stat = await handle.stat().catch(fail);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || owner !== undefined && stat.uid !== owner) return fail();
      anchors.set(part, { handle, ino: stat.ino, dev: stat.dev });
    }
    const initializeClient = options.testInitializeFsClient ?? initializeOrganizationHandoffAuthorityFsClient;
    for (const [part, anchor] of anchors) {
      const client = await initializeClient({ cwd: path.join(root, part), dev: anchor.dev, ino: anchor.ino,
        ...(owner === undefined ? {} : { uid: owner }), ...(options.workerPath === undefined ? {} : { workerPath: options.workerPath }) });
      // Transfer each completed helper into rollback ownership immediately.
      clients.set(part, client);
    }
  } catch (error) {
    await Promise.all([...clients.values()].map(async (client) => client.dispose()));
    await Promise.all([...anchors.values()].map(async ({ handle }) => { await handle.close().catch(() => undefined); }));
    return fail(error);
  }
  return new Store(root, anchors, clients, options.testHooks);
};
