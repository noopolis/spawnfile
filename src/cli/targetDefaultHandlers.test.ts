import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TargetResourceRequest } from "../target/contracts.js";
import type { SelectTargetOptions } from "../target/dockerTarget.js";
import type { TargetDefaultAuthorities } from "./targetDefaultAuthorities.js";
import { loadTargetDefaultConfig, type TargetDefaultConfig } from "./targetDefaultConfig.js";
import {
  activateTargetDefaultTopology,
  attestTargetDefaultTopology,
  createTargetDefaultHandlerSession,
  createTargetDefaultHandlers,
  runTargetDefaultHandlerSession,
  snapshotTargetDefaultPublicArtifact,
  withTargetDefaultHandlerSession,
  type TargetDefaultHandlerFactories
} from "./targetDefaultHandlers.js";

const operations = [
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
  "select_target",
  "start_world_service",
  "stop_world_service"
] as const;
const family: Record<(typeof operations)[number], string> = {
  attach_organization: "attachment",
  cleanup_run: "cleanup",
  create_data_network: "resource",
  create_evidence_volume: "resource",
  create_world_service: "world",
  detach_organization: "attachment",
  export_evidence_volume: "evidence.execute",
  prepare_secret_bindings: "secret",
  recover_operation: "evidence.recover",
  resolve_world_artifact: "artifact",
  revoke_secret_bindings: "secret",
  select_target: "select",
  start_world_service: "world",
  stop_world_service: "world"
};
const result = Object.freeze({
  receipt: Object.freeze({ marker: "exact-receipt" }),
  receiptBytes: "exact-bytes"
});
const config = Object.freeze({
  artifactMappings: Object.freeze([Object.freeze({
    artifact_manifest_digest: `sha256:${"a".repeat(64)}`,
    image_digest: `sha256:${"b".repeat(64)}`,
    image_reference: `registry.example/helper@sha256:${"b".repeat(64)}`
  })]),
  context: "prod_1",
  dockerCommand: "docker-safe",
  evidenceDestination: "/private/output/evidence.tar",
  helperArtifact: Object.freeze({
    artifact_manifest_digest: `sha256:${"a".repeat(64)}`,
    image_digest: `sha256:${"b".repeat(64)}`,
    image_reference: `registry.example/helper@sha256:${"b".repeat(64)}`
  }),
  paths: Object.freeze({}),
  preparedArtifactMappings: Object.freeze([]),
  resolvers: Object.freeze({ handoff: {}, secret: {} }),
  timeoutMs: 30_000
}) as unknown as TargetDefaultConfig;
const lifecycleRoots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;
const productionConfig = async (): Promise<TargetDefaultConfig> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-handler-session-")));
  lifecycleRoots.push(root);
  const home = path.join(root, "home");
  const output = path.join(root, "output");
  await mkdir(home, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  process.env.SPAWNFILE_HOME = home;
  return loadTargetDefaultConfig({
    artifactMappings: config.artifactMappings,
    context: "prod_1",
    dockerCommand: "docker-safe",
    evidenceDestination: path.join(output, "evidence.tar"),
    helperArtifactManifestDigest: config.helperArtifact!.artifact_manifest_digest,
    timeoutMs: 30_000
  });
};

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(lifecycleRoots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

const fixture = () => {
  const calls: Array<{ family: string; options: Record<string, unknown>; request: unknown }> = [];
  const journal = Object.freeze({ marker: "journal", withLifecycleLease: async <Result>(action: () => Promise<Result>): Promise<Result> => action() });
  const resolveJournal = vi.fn(async ({ request }: { request: unknown }) => ({
    journal,
    request,
    selectedTarget: {}
  }));
  const resourceExecutor = vi.fn(async () => ({ stderr: "", stdout: "endpoint" }));
  const helper = Object.freeze({
    artifactIdentity: {},
    bundle: Object.freeze({
      operation_handle: "opaque_helperoperation",
      request_digest: `sha256:${"c".repeat(64)}`,
      result_handle: "opaque_helperresult01"
    }),
    mapping: config.helperArtifact
  });
  const resolveHelper = vi.fn(async () => helper);
  const executor = vi.fn();
  const authorities = {
    artifactIdentityStore: Object.freeze({ marker: "artifact-store" }),
    attachmentAuthorityStore: Object.freeze({ marker: "attachment-store" }),
    evidenceExportAuthorityStore: Object.freeze({ marker: "evidence-store" }),
    executors: Object.freeze({
      artifact: executor,
      attachment: executor,
      evidenceExport: executor,
      publicArtifact: executor,
      resource: resourceExecutor,
      secret: executor,
      world: executor
    }),
    handoffResolver: Object.freeze({ resolve: vi.fn() }),
    helperArtifactResolver: Object.freeze({ resolve: resolveHelper }),
    helperExecutor: executor,
    journals: Object.freeze({ resolve: resolveJournal }),
    secretAuthorityStore: Object.freeze({ marker: "secret-store" }),
    secretResolver: Object.freeze({ resolve: vi.fn() }),
    topologyAttestor: Object.freeze({ activate: vi.fn(), attest: vi.fn() }),
    worldAuthorityStore: Object.freeze({ marker: "world-store" }),
    worldResolver: Object.freeze({ resolve: vi.fn() })
  } as unknown as TargetDefaultAuthorities;
  const operationFactory = (name: string) => vi.fn((options: Record<string, unknown>) => ({
    execute: async (request: unknown) => {
      calls.push({ family: name, options, request });
      return result;
    }
  }));
  const evidence = vi.fn((options: Record<string, unknown>) => ({
    execute: async (request: unknown, destination: unknown) => {
      calls.push({ family: "evidence.execute", options, request: { destination, request } });
      return result;
    },
    recover: async (request: unknown, destination: unknown) => {
      calls.push({ family: "evidence.recover", options, request: { destination, request } });
      return result;
    }
  }));
  const select = vi.fn(async (_options: SelectTargetOptions) => Object.freeze({
    fingerprint: `sha256:${"d".repeat(32)}`,
    handle: "opaque_selectedtarget01",
    version: "spawnfile.target-resource.selected-target.v1"
  }) as never);
  const factories: TargetDefaultHandlerFactories = {
    artifact: operationFactory("artifact"),
    attachment: operationFactory("attachment"),
    cleanup: operationFactory("cleanup"),
    evidence,
    resource: operationFactory("resource"),
    secret: operationFactory("secret"),
    select,
    world: operationFactory("world")
  };
  return {
    authorities,
    calls,
    evidence,
    factories,
    resolveHelper,
    resolveJournal,
    resourceExecutor,
    select
  };
};
const request = (operation: string): TargetResourceRequest => operation === "export_evidence_volume"
  ? ({
      descriptor_digest: `sha256:${"e".repeat(64)}`,
      evidence_volume_handle: "opaque_evidencevolume01",
      expected_revision: 7,
      idempotency_key: "idem_exportevidence01",
      operation,
      run_id: "run-one",
      selected_target: {
        fingerprint: `sha256:${"d".repeat(32)}`,
        handle: "opaque_selectedtarget01"
      },
      version: "spawnfile.target-resource.request.v1"
    } as TargetResourceRequest)
  : ({ operation, target_reference: "prod_1" }) as TargetResourceRequest;

describe("private default target handler composition", () => {
  it("makes the production authority graph an explicit closeable handler session", async () => {
    const session = await createTargetDefaultHandlerSession(await productionConfig());
    expect(Object.keys(session.handlers).sort()).toEqual([...operations].sort());
    await Promise.all([session.dispose(), session.dispose(), session.dispose()]);
  });

  it("closes the production session after return, throw, and observed abort", async () => {
    const normal = await withTargetDefaultHandlerSession(
      await productionConfig(),
      async (handlers) => Object.keys(handlers).length
    );
    expect(normal).toBe(14);
    await expect(withTargetDefaultHandlerSession(
      await productionConfig(),
      async () => { throw new Error("sentinel"); }
    )).rejects.toThrow("sentinel");
    const controller = new AbortController();
    controller.abort();
    const preAbortedConfig = await productionConfig();
    const beforePreAbort = await readdir(process.env.SPAWNFILE_HOME!);
    await expect(withTargetDefaultHandlerSession(
      preAbortedConfig,
      async () => "unreachable",
      controller.signal
    )).rejects.toThrow("Target handler initialization failed");
    expect(await readdir(process.env.SPAWNFILE_HOME!)).toEqual(beforePreAbort);
  });

  it("does not attach an abort listener or dispose through abort while a handler is in flight", async () => {
    let settle: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const signal = Object.assign(new EventTarget(), { aborted: false }) as AbortSignal;
    const invocation = withTargetDefaultHandlerSession(
      await productionConfig(),
      async () => { entered?.(); await gate; return 14; },
      signal
    );
    await started;
    signal.dispatchEvent(new Event("abort"));
    settle?.();
    await expect(invocation).resolves.toBe(14);
  });

  it("disposes the initialized session without invoking when abort wins initialization", async () => {
    let checks = 0;
    const signal = Object.defineProperty({}, "aborted", {
      get: () => ++checks > 1
    }) as AbortSignal;
    let invoked = false;
    await expect(withTargetDefaultHandlerSession(
      await productionConfig(),
      async () => { invoked = true; return 14; },
      signal
    )).rejects.toThrow("Target handler initialization failed");
    expect(invoked).toBe(false);
    expect(checks).toBe(2);
  });

  it("disposes an initialized session exactly once before rejecting an initialization-window abort", async () => {
    let disposed = 0;
    let invoked = false;
    const session = { dispose: async () => { disposed += 1; }, handlers: {} as never };
    let checks = 0;
    const signal = Object.defineProperty({}, "aborted", { get: () => ++checks >= 1 }) as AbortSignal;
    await expect(runTargetDefaultHandlerSession(session, async () => { invoked = true; return 14; }, signal))
      .rejects.toThrow("Target handler initialization failed");
    expect(invoked).toBe(false);
    expect(disposed).toBe(1);
  });

  it("freezes exactly fourteen handlers and routes every operation once", async () => {
    const value = fixture();
    const handlers = await createTargetDefaultHandlers(config, value.factories, value.authorities);
    expect(Object.keys(handlers).sort()).toEqual([...operations].sort());
    expect(Reflect.ownKeys(handlers)).toHaveLength(14);
    expect(Object.isFrozen(handlers)).toBe(true);
    for (const operation of operations) {
      const output = await (handlers[operation] as (raw: never) => Promise<unknown>)(
        request(operation) as never
      );
      if (operation === "select_target") continue;
      expect(output).toBe(result);
      expect(value.calls.at(-1)?.family).toBe(family[operation]);
      expect(value.resolveJournal).toHaveBeenLastCalledWith({
        context: "prod_1",
        request: request(operation)
      });
    }
    expect(value.calls).toHaveLength(14);
    expect(value.resolveJournal).toHaveBeenCalledTimes(13);
  });

  it("passes exact reviewed dependencies to each family", async () => {
    const value = fixture();
    const handlers = await createTargetDefaultHandlers(config, value.factories, value.authorities);
    for (const operation of [
      "resolve_world_artifact",
      "prepare_secret_bindings",
      "create_data_network",
      "attach_organization",
      "create_world_service",
      "cleanup_run"
    ] as const) {
      await (handlers[operation] as (raw: never) => Promise<unknown>)(request(operation) as never);
    }
    for (const call of value.calls) {
      expect(call.options).toMatchObject({
        context: config.context,
        journal: { marker: "journal" },
        timeoutMs: config.timeoutMs
      });
    }
    expect(value.calls[0]!.options).toMatchObject({
      identityStore: value.authorities.artifactIdentityStore,
      mappings: config.artifactMappings
    });
    expect(value.calls[1]!.options).toMatchObject({
      authorityStore: value.authorities.secretAuthorityStore,
      resolver: value.authorities.secretResolver
    });
    expect(value.calls[3]!.options).toMatchObject({
      authorityStore: value.authorities.attachmentAuthorityStore,
      resolver: value.authorities.handoffResolver
    });
    expect(value.calls[4]!.options).toMatchObject({
      authorityStore: value.authorities.worldAuthorityStore,
      resolver: value.authorities.worldResolver
    });
  });

  it("requires the configured selection name and performs one reviewed selection", async () => {
    const value = fixture();
    const handlers = await createTargetDefaultHandlers(config, value.factories, value.authorities);
    await expect(handlers.select_target({
      operation: "select_target",
      target_reference: "wrong",
      version: "spawnfile.target-resource.request.v1",
      idempotency_key: "idem_aaaaaaaaaaaaaaaa"
    })).rejects.toThrow("Target selection failed");
    expect(value.select).not.toHaveBeenCalled();
    const selected = await handlers.select_target(request("select_target") as never);
    expect(selected).toBe(await value.select.mock.results[0]!.value);
    expect(value.select).toHaveBeenCalledTimes(1);
    expect(value.select.mock.calls[0]![0]).toMatchObject({
      context: config.context,
      dockerCommand: config.dockerCommand,
      timeoutMs: config.timeoutMs
    });
    const execFile = value.select.mock.calls[0]![0].execFile!;
    await execFile("docker-safe", ["context", "inspect"], { timeout: 30_000 });
    expect(value.resourceExecutor).toHaveBeenCalledWith(
      "docker",
      ["context", "inspect"],
      { timeout: 30_000 }
    );
  });

  it("uses the same explicit destination and helper for export and recovery", async () => {
    const value = fixture();
    const handlers = await createTargetDefaultHandlers(config, value.factories, value.authorities);
    await expect(handlers.export_evidence_volume(request("export_evidence_volume") as never))
      .resolves.toBe(result);
    await expect(handlers.recover_operation(request("recover_operation") as never))
      .resolves.toBe(result);
    expect(value.resolveHelper).toHaveBeenCalledTimes(2);
    expect(value.calls.filter(({ family }) => family.startsWith("evidence."))
      .map((call) => call.request)).toEqual([
      { destination: config.evidenceDestination, request: request("export_evidence_volume") },
      { destination: config.evidenceDestination, request: request("recover_operation") }
    ]);
    const helperResolution = value.calls.find(({ family, request: callRequest }) =>
      family === "artifact"
      && (callRequest as { artifact_manifest_digest?: unknown }).artifact_manifest_digest
        === config.helperArtifact!.artifact_manifest_digest);
    expect(helperResolution?.request).toMatchObject({
      descriptor_digest: (request("export_evidence_volume") as { descriptor_digest: string })
        .descriptor_digest,
      expected_revision: 6,
      idempotency_key: expect.stringMatching(/^idem_[a-f0-9]{32}$/u),
      operation: "resolve_world_artifact",
      run_id: "run-one"
    });
    expect(value.calls.findIndex((call) => call === helperResolution)).toBeLessThan(
      value.calls.findIndex(({ family }) => family === "evidence.execute")
    );
    expect(value.evidence).toHaveBeenCalledTimes(2);
  });

  it("keeps generic operations available without a helper and fails evidence closed on invocation", async () => {
    const value = fixture();
    const { helperArtifact: _helper, ...helperFreeConfig } = config as unknown as Record<string, unknown>;
    const { helperArtifactResolver: _resolver, ...helperFreeAuthorities } = value.authorities as unknown as Record<string, unknown>;
    const handlers = await createTargetDefaultHandlers(
      helperFreeConfig as unknown as TargetDefaultConfig,
      value.factories,
      helperFreeAuthorities as unknown as TargetDefaultAuthorities
    );
    await expect(handlers.create_data_network(request("create_data_network") as never)).resolves.toBe(result);
    await expect(handlers.export_evidence_volume(request("export_evidence_volume") as never))
      .rejects.toThrow("Target evidence helper is not configured");
    expect(value.resolveHelper).not.toHaveBeenCalled();
    expect(value.evidence).not.toHaveBeenCalled();
  });

  it("propagates handler failures without retry or fallback", async () => {
    const value = fixture();
    const sentinel = new Error("sentinel");
    const failingFactories = {
      ...value.factories,
      resource: vi.fn(() => ({
        execute: vi.fn(async () => { throw sentinel; })
      }))
    };
    const handlers = await createTargetDefaultHandlers(config, failingFactories, value.authorities);
    await expect(handlers.create_data_network(request("create_data_network") as never))
      .rejects.toBe(sentinel);
    expect(failingFactories.resource).toHaveBeenCalledTimes(1);
    expect(value.resolveJournal).toHaveBeenCalledTimes(1);
    expect(value.calls).toHaveLength(0);

    const missing = fixture();
    await expect(createTargetDefaultHandlers(config, missing.factories, {} as TargetDefaultAuthorities))
      .rejects.toThrow("Target handler initialization failed");
  });

  it("rejects crossed operations before journal or factory effects", async () => {
    const value = fixture();
    const handlers = await createTargetDefaultHandlers(config, value.factories, value.authorities);
    await expect((handlers.create_data_network as (raw: unknown) => Promise<unknown>)(
      request("create_evidence_volume")
    )).rejects.toThrow("Target operation mismatch");
    expect(value.resolveJournal).not.toHaveBeenCalled();
    expect(value.calls).toHaveLength(0);

    value.resolveJournal.mockResolvedValueOnce({
      journal: { marker: "journal" },
      request: request("create_evidence_volume"),
      selectedTarget: {}
    } as never);
    await expect((handlers.create_data_network as (raw: unknown) => Promise<unknown>)(
      request("create_data_network")
    )).rejects.toThrow("Target operation mismatch");
    expect(value.resolveJournal).toHaveBeenCalledTimes(1);
    expect(value.calls).toHaveLength(0);
  });

  it("rejects hostile dependency shapes without getters or effects", async () => {
    let reads = 0;
    const value = fixture();
    const accessor = { ...value.factories } as Record<string, unknown>;
    Object.defineProperty(accessor, "resource", {
      enumerable: true,
      get: () => { reads += 1; return value.factories.resource; }
    });
    await expect(createTargetDefaultHandlers(config, accessor as never, value.authorities))
      .rejects.toThrow("Target handler initialization failed");
    await expect(createTargetDefaultHandlers(
      config,
      new Proxy(value.factories, {}) as never,
      value.authorities
    )).rejects.toThrow("Target handler initialization failed");
    expect(reads).toBe(0);

    const nested = fixture();
    const hostileExecutors = { ...nested.authorities.executors } as Record<string, unknown>;
    Object.defineProperty(hostileExecutors, "resource", {
      enumerable: true,
      get: () => { reads += 1; return vi.fn(); }
    });
    const hostileAuthority = {
      ...nested.authorities,
      executors: hostileExecutors
    };
    await expect(createTargetDefaultHandlers(config, nested.factories, hostileAuthority as never))
      .rejects.toThrow("Target handler initialization failed");
    expect(reads).toBe(0);
    expect(nested.resolveJournal).not.toHaveBeenCalled();
    expect(nested.calls).toHaveLength(0);

    const extra = { ...nested.factories, extra: true };
    await expect(createTargetDefaultHandlers(config, extra as never, nested.authorities))
      .rejects.toThrow("Target handler initialization failed");
    const hidden = { ...nested.factories } as Record<string, unknown>;
    Object.defineProperty(hidden, "world", {
      enumerable: false,
      value: nested.factories.world
    });
    await expect(createTargetDefaultHandlers(config, hidden as never, nested.authorities))
      .rejects.toThrow("Target handler initialization failed");

    await expect(createTargetDefaultHandlers(
      config,
      { ...nested.factories, artifact: null } as never,
      nested.authorities
    )).rejects.toThrow("Target handler initialization failed");
    await expect(createTargetDefaultHandlers(
      config,
      nested.factories,
      null as never
    )).rejects.toThrow("Target handler initialization failed");
  });

  it("closes read-only production sessions when public requests fail validation", async () => {
    const topologyConfig = await productionConfig();
    await expect(attestTargetDefaultTopology(topologyConfig, {} as never)).rejects.toThrow();
    await expect(activateTargetDefaultTopology(topologyConfig, {} as never)).rejects.toThrow();
    await expect(snapshotTargetDefaultPublicArtifact(topologyConfig, {} as never)).rejects.toThrow();
  });
});
