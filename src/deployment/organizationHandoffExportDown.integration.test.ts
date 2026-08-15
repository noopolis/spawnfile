import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./organizationHandoffAuthorityStore.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./organizationHandoffAuthorityStore.js")>(),
  initializeOrganizationHandoffAuthorityStore: vi.fn()
}));

import { writeUtf8File } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import {
  createTargetReceiptDigest,
  initializeTargetJournal,
  parseTargetResourceRequest,
  TARGET_RESOURCE_RECEIPT_VERSION,
  TARGET_RESOURCE_REQUEST_VERSION,
  type TargetJournalClaim,
  type TargetResourceRequest
} from "../target/index.js";

import { exportRunArtifacts } from "./artifactsExport.js";
import { downDeployment } from "./downDeployment.js";
import {
  initializeOrganizationHandoffAuthorityStore,
  type OrganizationHandoffAuthorityStore
} from "./organizationHandoffAuthorityStore.js";
import { createOrganizationHandoff, parseCanonicalSha256Digest } from "./organizationHandoffTypes.js";
import { readDeploymentRecord, writeDeploymentRecord, type DeploymentRecord } from "./record.js";

type MutationRequest = Exclude<TargetResourceRequest, { operation: "select_target" }>;

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
const selectedTarget = {
  fingerprint: `sha256:${"b".repeat(32)}`,
  handle: `opaque_${"c".repeat(16)}`
} as const;
const selectedReceipt = { ...selectedTarget, version: "spawnfile.target-resource.selected-target.v1" } as const;
const handoffHandle = `opaque_${"d".repeat(16)}` as never;
const targetHandoffHandle = `opaque_${"e".repeat(16)}`;
const networkHandle = `opaque_${"f".repeat(16)}`;
const attachmentHandle = `opaque_${"g".repeat(16)}`;

const root = async (prefix: string): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  await chmod(value, 0o700);
  roots.push(value);
  return value;
};

afterEach(async () => {
  vi.mocked(initializeOrganizationHandoffAuthorityStore).mockReset();
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

const record = (outputDirectory: string): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "sf1.handoff-proof",
  created_at: "2026-07-24T00:00:00.000Z",
  manager: "docker",
  name: "football",
  organization_handoff: createOrganizationHandoff("run-one", {
    bindingDigest: parseCanonicalSha256Digest(`sha256:${"1".repeat(64)}`),
    networkAttachmentHandle: targetHandoffHandle as never,
    selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"2".repeat(64)}`)
  }),
  organization_handoff_handle: handoffHandle,
  output_directory: outputDirectory,
  run_id: "run-one",
  source: { kind: "project", root: "/project" },
  target: { endpoint_fingerprint: `sha256:${"3".repeat(32)}`, kind: "context", name: "remote_host" },
  units: [{
    container_id: "container-123",
    container_name: "football",
    contains: [],
    id: "football-container",
    image_id: "image-123",
    image_tag: "football:latest",
    kind: "container",
    runtime_instances: []
  }],
  version: "spawnfile.deployment.v2"
});

const emptyArtifactReport = (): CompileReport => ({
  container: { persistent_mounts: [], runtime_instances: [] },
  diagnostics: [], nodes: [], root: "/project", spawnfile_version: "0.1"
} as unknown as CompileReport);

const request = (operation: "create_data_network" | "attach_organization" | "detach_organization", revision: number, key: string, extra: Record<string, unknown> = {}): MutationRequest => ({
  descriptor_digest: digest,
  expected_revision: revision,
  idempotency_key: key,
  operation,
  run_id: "run-one",
  selected_target: selectedTarget,
  version: TARGET_RESOURCE_REQUEST_VERSION,
  ...extra
} as MutationRequest);

const complete = async (
  journal: Awaited<ReturnType<typeof initializeTargetJournal>>,
  raw: MutationRequest,
  resultHandle: string | null
): Promise<TargetJournalClaim> => {
  const reserved = await journal.reserve(raw);
  expect(reserved.kind).toBe("owner");
  if (reserved.kind !== "owner") throw new Error("expected target journal owner");
  const body = {
    cleanup_state: "not_requested" as const,
    descriptor_digest: digest,
    export_state: "not_requested" as const,
    labels: [],
    operation: raw.operation,
    operation_handle: reserved.claim.operationHandle,
    receipt_digest: digest,
    request_digest: reserved.claim.requestDigest,
    result_handle: resultHandle,
    resulting_revision: raw.expected_revision + 1,
    run_id: "run-one",
    selected_target: selectedTarget,
    version: TARGET_RESOURCE_RECEIPT_VERSION
  };
  await journal.complete(reserved.claim, { ...body, receipt_digest: createTargetReceiptDigest(body) });
  return reserved.claim;
};

const authority = (seen: string[]): OrganizationHandoffAuthorityStore => ({
  begin: async () => { throw new Error("not used"); },
  close: async ({ expectedHandoff, organizationHandoffHandle }) => {
    seen.push(`${organizationHandoffHandle}:${(expectedHandoff as { deployment_handle: string }).deployment_handle}`);
  },
  dispose: async () => undefined,
  finalize: async () => { throw new Error("not used"); },
  observeDockerMutation: async () => { throw new Error("not used"); },
  readDockerMutation: async () => null,
  reserve: async () => { throw new Error("not used"); },
  resolver: { resolve: async () => { throw new Error("not used"); } }
});

describe("organization handoff export/down boundary", () => {
  it("preserves the public handoff byte-for-byte while export/down leave attachment transitions solely in the target journal", async () => {
    const output = await root("spawnfile-handoff-export-down-");
    const destination = await root("spawnfile-handoff-export-out-");
    const journalRoot = await root("spawnfile-handoff-target-journal-");
    await writeDeploymentRecord(output, record(output));
    await writeUtf8File(path.join(output, "spawnfile-report.json"), JSON.stringify(emptyArtifactReport()));

    const journal = await initializeTargetJournal({
      context: "remote_host", descriptorDigest: digest, root: journalRoot, runId: "run-one", selectedTarget: selectedReceipt
    });
    await complete(journal, request("create_data_network", 0, "idem_aaaaaaaaaaaaaaaa"), networkHandle);
    const attachRequest = parseTargetResourceRequest(request("attach_organization", 1, "idem_bbbbbbbbbbbbbbbb", {
      data_network_handle: networkHandle, organization_handoff_handle: handoffHandle
    }));
    expect(attachRequest.operation).toBe("attach_organization");
    if (attachRequest.operation !== "attach_organization") throw new Error("expected attach request");
    expect(attachRequest.organization_handoff_handle).toBe(handoffHandle);
    await complete(journal, attachRequest, attachmentHandle);
    await complete(journal, request("detach_organization", 2, "idem_cccccccccccccccccc", {
      data_network_handle: networkHandle, organization_attachment_handle: attachmentHandle
    }), null);
    const journalPath = path.join(journalRoot, (await readdir(journalRoot)).find((entry) => entry.endsWith(".json"))!);
    const journalBytes = await readFile(journalPath, "utf8");

    const recordPath = path.join(output, "deployments", "football.json");
    const before = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    const handoffBytes = JSON.stringify(before.organization_handoff);
    const privateHandle = before.organization_handoff_handle;

    await exportRunArtifacts({
      compiledOutputDirectory: output,
      deploymentName: "football",
      destinationDirectory: destination,
      execFile: async () => { throw new Error("empty export plan must not invoke Docker"); }
    });
    const afterExport = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(afterExport.organization_handoff)).toBe(handoffBytes);
    expect(afterExport.organization_handoff_handle).toBe(privateHandle);
    expect(afterExport).not.toHaveProperty("organization_attachment_handle");
    expect(await readFile(journalPath, "utf8")).toBe(journalBytes);

    const closed: string[] = [];
    vi.mocked(initializeOrganizationHandoffAuthorityStore).mockResolvedValue(authority(closed));
    await downDeployment({
      compiledOutputDirectory: output,
      deploymentName: "football",
      execFile: async () => ({ stderr: "", stdout: "" })
    });

    const afterDownBytes = await readFile(recordPath, "utf8");
    const afterDown = JSON.parse(afterDownBytes) as Record<string, unknown>;
    expect(JSON.stringify(afterDown.organization_handoff)).toBe(handoffBytes);
    expect(afterDown.organization_handoff_handle).toBe(privateHandle);
    expect(afterDown).not.toHaveProperty("organization_attachment_handle");
    expect(await readFile(journalPath, "utf8")).toBe(journalBytes);
    expect(closed).toEqual([`${privateHandle}:${(await readDeploymentRecord(recordPath)).organization_handoff?.deployment_handle}`]);
  });
});
