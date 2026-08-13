import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const selectedTarget = {
    fingerprint: `sha256:${"f".repeat(32)}`,
    handle: `opaque_${"a".repeat(32)}`
  };
  const prepared = {
    archive_digest: `sha256:${"1".repeat(64)}`,
    artifact_digest: `sha256:${"2".repeat(64)}`,
    base_image_config_digest: `sha256:${"3".repeat(64)}`,
    build_policy_digest: `sha256:${"4".repeat(64)}`,
    bundle_digest: `sha256:${"5".repeat(64)}`,
    config_id: `sha256:${"6".repeat(64)}`,
    daemon_epoch: `sha256:${"7".repeat(64)}`,
    entrypoint: "runtime/start.mjs",
    gc_tag: `spfb_${"8".repeat(58)}`,
    identity_kind: "docker_image_config_digest" as const,
    launcher_digest: `sha256:${"9".repeat(64)}`,
    network_alias: "world",
    operation_handle: `opaque_${"b".repeat(32)}`,
    platform: { architecture: "amd64", os: "linux" } as const,
    platform_digest: `sha256:${"c".repeat(64)}`,
    request_digest: `sha256:${"d".repeat(64)}`,
    selected_target: selectedTarget
  };
  const binding = {
    archiveDigest: prepared.archive_digest,
    artifactManifestDigest: prepared.artifact_digest,
    baseImageConfigDigest: prepared.base_image_config_digest,
    buildPolicyDigest: prepared.build_policy_digest,
    bundleDigest: prepared.bundle_digest,
    configId: prepared.config_id,
    daemonEpoch: prepared.daemon_epoch,
    entrypoint: prepared.entrypoint,
    gcTag: prepared.gc_tag,
    identityKind: prepared.identity_kind,
    launcherDigest: prepared.launcher_digest,
    networkAlias: prepared.network_alias,
    operationHandle: `opaque_${"e".repeat(32)}`,
    platform: prepared.platform,
    platformDigest: prepared.platform_digest,
    preparedOperationHandle: prepared.operation_handle,
    preparedRequestDigest: prepared.request_digest,
    requestDigest: `sha256:${"0".repeat(64)}`,
    resultHandle: `opaque_${"1".repeat(32)}`,
    selectedTargetHandle: selectedTarget.handle
  };
  return {
    attestPreparedArtifactIdentity: vi.fn(async () => undefined),
    binding,
    bindings: [binding] as Array<Record<string, unknown>>,
    dispose: vi.fn(async () => undefined),
    parseAuthorization: vi.fn((value: unknown) => value),
    prepared,
    resolveExistingIdentity: vi.fn(async () => ({})),
    resolvePrepared: vi.fn(async () => prepared),
    selectedTarget
  };
});

vi.mock("../target/dockerArtifactsProvider.js", () => ({
  initializeDockerArtifactIdentityStore: vi.fn(async () => ({}))
}));
vi.mock("../target/dockerCommandExecutor.js", () => ({
  createDockerTargetExecutors: vi.fn(() => ({
    artifact: {},
    attachment: {},
    resource: {},
    world: {}
  }))
}));
vi.mock("../target/dockerSecretsAuthority.js", () => ({
  initializeTargetSecretVersionAuthorityStore: vi.fn(async () => ({}))
}));
vi.mock("../target/dockerWorldServiceAuthority.js", () => ({
  parseWorldServiceAuthorization: state.parseAuthorization,
  parseWorldServiceResolution: vi.fn((value) => value)
}));
vi.mock("../target/dockerWorldServiceStore.js", () => ({
  initializeWorldServiceAuthorityStore: vi.fn(async () => ({}))
}));
vi.mock("../target/evidenceExportStore.js", () => ({
  initializeEvidenceExportAuthorityStore: vi.fn(async () => ({}))
}));
vi.mock("../target/organizationAttachmentStore.js", () => ({
  initializeOrganizationAttachmentAuthorityStore: vi.fn(async () => ({}))
}));
vi.mock("../target/topologyAttestation.js", () => ({
  createTargetTopologyAttestor: vi.fn((input) => ({ resolveJournal: input.resolveJournal }))
}));
vi.mock("../auth/targetSecretSourceResolver.js", () => ({
  initializeTargetSecretSourceResolver: vi.fn(async () => ({}))
}));
vi.mock("../deployment/organizationHandoffAuthorityStore.js", () => ({
  initializeOrganizationHandoffAuthorityStore: vi.fn(async () => ({
    dispose: state.dispose,
    resolver: {}
  }))
}));
vi.mock("./targetDefaultArtifactAuthority.js", () => ({
  completedTargetArtifacts: vi.fn(async () => state.bindings),
  exactTargetArtifactMapping: vi.fn()
}));
vi.mock("./targetDefaultJournalAuthority.js", () => ({
  TARGET_DEFAULT_AUTHORITIES_ERROR: "Target authority initialization failed",
  createTargetJournalAccess: vi.fn(() => ({
    resolveExistingIdentity: state.resolveExistingIdentity,
    resolveIdentity: vi.fn(async () => ({})),
    resolver: { resolve: vi.fn() }
  }))
}));
vi.mock("../target/dockerContainerBundleBuilder.js", () => ({
  createDockerTargetLocalBundleBuilder: vi.fn(() => ({}))
}));
vi.mock("../target/dockerPreparedArtifact.js", () => ({
  attestPreparedArtifactIdentity: state.attestPreparedArtifactIdentity
}));
vi.mock("../target/containerBundleFilesystemStore.js", () => ({
  initializeFilesystemTargetLocalBundleStore: vi.fn(async () => ({
    resolve: state.resolvePrepared
  }))
}));

afterEach(() => {
  vi.clearAllMocks();
  state.bindings = [state.binding];
  state.resolvePrepared.mockImplementation(async () => state.prepared);
});

describe("default prepared-artifact authority composition", () => {
  it("revalidates the private prepared mapping before projecting a world artifact", async () => {
    const { initializeTargetDefaultAuthoritySession } = await import("./targetDefaultAuthorities.js");
    const config = {
      context: "prod_1",
      dockerCommand: "docker-safe",
      paths: {
        artifactIdentities: "/tmp/artifact-identities",
        attachmentAuthority: "/tmp/attachments",
        containerBundles: "/tmp/container-bundles",
        evidenceExport: "/tmp/evidence",
        journals: "/tmp/journals",
        secretAuthority: "/tmp/secrets",
        worldAuthority: "/tmp/world"
      },
      timeoutMs: 1_000
    } as never;
    const session = await initializeTargetDefaultAuthoritySession(config);
    const authorization = {
      descriptor_digest: `sha256:${"a".repeat(64)}`,
      run_id: "run-one",
      selected_target: state.selectedTarget,
      world_artifact_handle: state.binding.resultHandle
    };

    const resolution = await session.authorities.worldResolver.resolve({ authorization } as never) as {
      artifact: Record<string, unknown>;
    };
    expect(resolution.artifact).toMatchObject({
      artifact_manifest_digest: state.binding.artifactManifestDigest,
      identity_kind: "docker_image_config_digest",
      image_digest: state.binding.configId,
      image_reference: state.binding.configId,
      prepared_operation_handle: state.binding.preparedOperationHandle,
      prepared_request_digest: state.binding.preparedRequestDigest,
      result_handle: state.binding.resultHandle
    });
    expect(state.resolvePrepared).toHaveBeenCalledWith({
      operation_handle: state.binding.preparedOperationHandle,
      request_digest: state.binding.preparedRequestDigest
    });
    expect(state.attestPreparedArtifactIdentity).toHaveBeenCalledWith(
      expect.anything(),
      state.binding,
      state.prepared,
      state.selectedTarget
    );
    await expect((session.authorities.topologyAttestor as unknown as {
      resolveJournal(input: {
        descriptorDigest: string;
        runId: string;
        selectedTarget: typeof state.selectedTarget;
      }): Promise<unknown>;
    }).resolveJournal({
      descriptorDigest: authorization.descriptor_digest,
      runId: authorization.run_id,
      selectedTarget: state.selectedTarget
    })).resolves.toEqual({});
    expect(state.resolveExistingIdentity).toHaveBeenCalled();

    state.parseAuthorization.mockImplementationOnce(() => { throw new Error("invalid"); });
    await expect(session.authorities.worldResolver.resolve({ authorization } as never))
      .rejects.toThrow("Target authority initialization failed");
    state.resolvePrepared.mockResolvedValueOnce(null as never);
    await expect(session.authorities.worldResolver.resolve({ authorization } as never))
      .rejects.toThrow("Target authority initialization failed");
    state.resolvePrepared.mockResolvedValueOnce({
      ...state.prepared,
      bundle_digest: `sha256:${"f".repeat(64)}`
    });
    await expect(session.authorities.worldResolver.resolve({ authorization } as never))
      .rejects.toThrow("Target authority initialization failed");
    state.bindings = [{ ...state.binding, identityKind: "unsupported" }];
    await expect(session.authorities.worldResolver.resolve({ authorization } as never))
      .rejects.toThrow("Target authority initialization failed");
    await session.dispose();
    expect(state.dispose).toHaveBeenCalledOnce();
  });
});
