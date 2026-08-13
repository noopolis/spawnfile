import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { initializeOrganizationHandoffAuthorityStore } from "../../src/deployment/organizationHandoffAuthorityStore.js";
import { createDockerOrganizationAttachmentOperations } from "../../src/target/organizationAttachment.js";
import { createDockerResourceSpec } from "../../src/target/dockerResourcesProvider.js";
import { createTargetReceiptDigest } from "../../src/target/handles.js";
import { initializeTargetJournal } from "../../src/target/journal.js";
import { parseOrganizationAttachmentResolution } from "../../src/target/organizationAttachmentAuthority.js";
import { initializeOrganizationAttachmentAuthorityStore } from "../../src/target/organizationAttachmentStore.js";

const VERSION = "spawnfile.deployment-handoff-attach.v1" as const;
const MAX_BYTES = 16_384;
const CONTEXT = "remote_4090";
const ENDPOINT = "ssh://operator@remote-4090";
const NETWORK_ID = "6".repeat(64);
type Request = {
  readonly authorization: Record<string, unknown>;
  readonly targetRoot: string;
  readonly version: typeof VERSION;
};
const bounded = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BYTES;
const valid = (raw: unknown): raw is Request =>
  raw !== null && typeof raw === "object" && Object.getPrototypeOf(raw) === Object.prototype
  && bounded(raw)
  && Object.keys(raw).sort().join(",") === "authorization,targetRoot,version"
  && (raw as { version?: unknown }).version === VERSION
  && typeof (raw as { targetRoot?: unknown }).targetRoot === "string"
  && path.isAbsolute((raw as { targetRoot: string }).targetRoot)
  && (raw as { authorization?: unknown }).authorization !== null
  && typeof (raw as { authorization?: unknown }).authorization === "object";
const send = (value: unknown): void => {
  if (!bounded(value) || process.send?.(value) !== true) process.exit(1);
};
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

let received = false;
process.once("message", async (raw: unknown) => {
  let executorCallCount = 0;
  let deploymentAuthority: Awaited<ReturnType<typeof initializeOrganizationHandoffAuthorityStore>> | undefined;
  try {
    if (received || !valid(raw)) throw new Error("invalid request");
    received = true;
    deploymentAuthority = await initializeOrganizationHandoffAuthorityStore();
    const resolution = parseOrganizationAttachmentResolution(
      await deploymentAuthority.resolver.resolve({ authorization: raw.authorization })
    );

    const journalRoot = path.join(raw.targetRoot, "journal");
    const authorityRoot = path.join(raw.targetRoot, "authority");
    await mkdir(journalRoot, { mode: 0o700, recursive: true });
    await mkdir(authorityRoot, { mode: 0o700, recursive: true });
    const selected = {
      ...resolution.authorization.selected_target,
      version: "spawnfile.target-resource.selected-target.v1" as const
    };
    const descriptorDigest = raw.authorization.descriptor_digest as string;
    const runId = raw.authorization.run_id as string;
    const journal = await initializeTargetJournal({
      context: CONTEXT,
      descriptorDigest,
      root: await realpath(journalRoot),
      runId,
      selectedTarget: selected
    });
    const networkRequest = {
      descriptor_digest: descriptorDigest,
      expected_revision: 0,
      idempotency_key: "idem_1111111111111111",
      operation: "create_data_network" as const,
      run_id: runId,
      selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
      version: "spawnfile.target-resource.request.v1" as const
    };
    const reservation = await journal.reserve(networkRequest);
    if (reservation.kind !== "owner") throw new Error("network reservation unavailable");
    const network = createDockerResourceSpec({
      kind: "data_network",
      operationHandle: reservation.claim.operationHandle,
      requestDigest: reservation.claim.requestDigest,
      runId,
      selectedTargetHandle: selected.handle
    });
    const receiptBase = {
      cleanup_state: "not_requested" as const,
      descriptor_digest: descriptorDigest,
      export_state: "not_requested" as const,
      labels: Object.entries(network.labels).map(([key, value]) => ({ key, value })),
      operation: "create_data_network" as const,
      operation_handle: reservation.claim.operationHandle,
      receipt_digest: digest("placeholder"),
      request_digest: reservation.claim.requestDigest,
      result_handle: network.resultHandle,
      resulting_revision: 1,
      run_id: runId,
      selected_target: networkRequest.selected_target,
      version: "spawnfile.target-resource.receipt.v1" as const
    };
    await journal.complete(reservation.claim, {
      ...receiptBase,
      receipt_digest: createTargetReceiptDigest(receiptBase)
    });

    let attached = false;
    const operations: string[] = [];
    const executor = async (_file: string, args: string[]) => {
      executorCallCount += 1;
      if (args[0] === "context") {
        operations.push("context inspect");
        return { stderr: "", stdout: JSON.stringify(ENDPOINT) };
      }
      const operation = `${args[2]} ${args[3]}`;
      operations.push(operation);
      if (operation === "network inspect") return {
        stderr: "",
        stdout: JSON.stringify([{ Id: NETWORK_ID, Internal: true, Labels: network.labels, Name: network.name }])
      };
      if (operation === "container inspect") return {
        stderr: "",
        stdout: JSON.stringify([{
          Attached: attached,
          Id: resolution.network_attachment.container_id,
          Labels: resolution.network_attachment.deployment_labels
        }])
      };
      if (operation === "network connect"
        && args[4] === NETWORK_ID && args[5] === resolution.network_attachment.container_id) {
        attached = true;
        return { stderr: "", stdout: "" };
      }
      throw new Error("unexpected Docker operation");
    };
    const targetAuthority = await initializeOrganizationAttachmentAuthorityStore(await realpath(authorityRoot));
    const targetOperations = createDockerOrganizationAttachmentOperations({
      authorityStore: targetAuthority,
      context: CONTEXT,
      executor,
      journal,
      resolver: deploymentAuthority.resolver
    });
    const attachedReceipt = await targetOperations.execute({
      data_network_handle: network.resultHandle,
      descriptor_digest: descriptorDigest,
      expected_revision: 1,
      idempotency_key: "idem_2222222222222222",
      operation: "attach_organization",
      organization_handoff_handle: resolution.authorization.organization_handoff_handle,
      run_id: runId,
      selected_target: networkRequest.selected_target,
      version: "spawnfile.target-resource.request.v1"
    });
    const expected = [
      "context inspect", "network inspect", "container inspect",
      "network connect", "container inspect", "network inspect"
    ];
    if (JSON.stringify(operations) !== JSON.stringify(expected)
      || typeof attachedReceipt.receipt.result_handle !== "string") throw new Error("unexpected attach evidence");
    await deploymentAuthority.dispose();
    send({
      attachmentHandle: attachedReceipt.receipt.result_handle,
      executorCallCount,
      ok: true,
      operations,
      version: VERSION
    });
    process.exit(0);
  } catch {
    await deploymentAuthority?.dispose().catch(() => undefined);
    send({ executorCallCount, failed: true, version: VERSION });
    process.exit(1);
  }
});

send({ ready: true, version: VERSION });
