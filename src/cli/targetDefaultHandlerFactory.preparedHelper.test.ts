import os from "node:os";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareEvidenceExportHelper } from "../evidenceExportHelper/index.js";
import { parseTargetResourceRequest } from "../target/contracts.js";
import { DockerArtifactProviderError } from "../target/dockerArtifactsProvider.js";
import type { TargetDefaultAuthorities } from "./targetDefaultAuthorities.js";
import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import {
  createTargetDefaultHandlers,
  type TargetDefaultHandlerFactories,
} from "./targetDefaultHandlerFactory.js";

const roots: string[] = [];
const digest = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const base = digest("a");
const helper = digest("b");
const parsedRequest = parseTargetResourceRequest({
  descriptor_digest: digest("c"),
  evidence_volume_handle: "opaque_evidencevolume01",
  expected_revision: 7,
  idempotency_key: "idem_exportevidence01",
  operation: "export_evidence_volume" as const,
  run_id: "run-one",
  selected_target: { fingerprint: `sha256:${"d".repeat(32)}`, handle: "opaque_selectedtarget01" },
  version: "spawnfile.target-resource.request.v1" as const,
});
if (parsedRequest.operation !== "export_evidence_volume") throw new Error("invalid test fixture");
const request = parsedRequest;

const helperConfig = Object.freeze({
  Cmd: [], Entrypoint: ["/bin/spawnfile-export-helper"],
  Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], ExposedPorts: null,
  Healthcheck: null, Labels: { "spawnfile.target.evidence-export.helper-contract": "v1" },
  User: "65534:65534", Volumes: null,
});

const docker = () => {
  const images = new Map<string, { readonly config: `sha256:${string}`; readonly helper: boolean }>([
    ["node:22-bookworm-slim", { config: base, helper: false }],
  ]);
  const executor = vi.fn(async (_file: string, args: string[]) => {
    const command = args.slice(2);
    if (command[0] === "context") return { stderr: "", stdout: JSON.stringify("unix:///tmp/docker.sock") };
    if (command[0] === "info") return { stderr: "", stdout: JSON.stringify({
      Architecture: "arm64", DockerRootDir: "/var/lib/docker", OSType: "linux", ServerVersion: "27.0",
    }) };
    if (command[0] === "image" && command[1] === "inspect") {
      const image = images.get(command[2]!);
      if (!image) throw new DockerArtifactProviderError("image_not_found");
      const format = command[command.indexOf("--format") + 1]!;
      return { stderr: "", stdout: JSON.stringify([format.includes("Config") ? {
        Architecture: "arm64", Config: image.helper ? helperConfig : {}, Id: image.config, Os: "linux",
      } : { Architecture: "arm64", Id: image.config, Os: "linux" }]) };
    }
    if (command[0] === "build") {
      images.set(helper, { config: helper, helper: true });
      expect(command).not.toContain("--tag");
      return { stderr: "", stdout: `${helper}\n` };
    }
    throw new Error(`unexpected Docker command: ${command.join(" ")}`);
  });
  return { executor, images };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("prepared local helper target handoff", () => {
  it("re-attests the opaque receipt inside the target before constructing evidence operations", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prepared-target-handler-")));
    roots.push(root);
    const privateRoot = path.join(root, "helper-authority");
    const targetDocker = docker();
    const receipt = await prepareEvidenceExportHelper({
      baseImage: "node:22-bookworm-slim", context: "local_dev",
      executor: targetDocker.executor, privateRoot,
    });
    const evidence = vi.fn(() => ({ execute: vi.fn(async () => ({ receipt: {}, receiptBytes: "exact" })) }));
    const operation = vi.fn(() => ({ execute: vi.fn(async () => ({ receipt: {}, receiptBytes: "exact" })) }));
    const regularArtifact = vi.fn(async () => { throw new Error("wrong helper executor"); });
    const factories: TargetDefaultHandlerFactories = {
      artifact: operation, attachment: operation, cleanup: operation, evidence: evidence as never,
      resource: operation, secret: operation, select: vi.fn(), world: operation,
    };
    const authorities = {
      artifactIdentityStore: {}, attachmentAuthorityStore: {}, evidenceExportAuthorityStore: {},
      executors: {
        artifact: regularArtifact, attachment: operation, evidenceExport: operation,
        publicArtifact: operation, resource: operation, secret: operation, world: operation,
      },
      handoffResolver: { resolve: vi.fn() },
      helperExecutor: targetDocker.executor,
      journals: { resolve: vi.fn(async ({ request: raw }) => ({
        journal: { withLifecycleLease: async <Result>(run: () => Promise<Result>) => run() },
        request: raw,
        selectedTarget: {},
      })) },
      secretAuthorityStore: {}, secretResolver: { resolve: vi.fn() },
      topologyAttestor: { activate: vi.fn(), attest: vi.fn() },
      worldAuthorityStore: {}, worldResolver: { resolve: vi.fn() },
    } as unknown as TargetDefaultAuthorities;
    const config = {
      artifactMappings: [], context: "local_dev", dockerCommand: "docker", evidenceDestination: "/private/evidence.tar",
      evidenceHelperBaseImage: "node:22-bookworm-slim", paths: { evidenceHelper: privateRoot },
      preparedArtifactMappings: [], preparedEvidenceHelper: receipt, timeoutMs: 120_000,
    } as unknown as TargetDefaultConfig;

    const handlers = await createTargetDefaultHandlers(config, factories, authorities);
    await handlers.export_evidence_volume(request);

    expect(targetDocker.executor.mock.calls.filter(([, args]) => args.includes("build"))).toHaveLength(1);
    expect(regularArtifact).not.toHaveBeenCalled();
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({
      helperArtifactManifestDigest: receipt.digest,
      localHelper: {
        artifactManifestDigest: receipt.digest,
        image_digest: helper,
        image_reference: helper,
        result_handle: receipt.handle,
      },
    }));
  });
});
