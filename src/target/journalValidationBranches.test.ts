import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TARGET_RESOURCE_RECEIPT_VERSION,
  TARGET_RESOURCE_REQUEST_VERSION,
} from "./contracts.js";
import {
  createPendingReceiptDigest,
  createTargetReceiptDigest,
} from "./handles.js";
import {
  initializeTargetJournal,
  lookupTargetOperation,
  openExistingTargetJournal,
  type TargetJournalClaim,
  type TargetJournalStore,
} from "./journal.js";

const descriptorDigest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const selectedTarget = {
  fingerprint: `sha256:${"b".repeat(32)}`,
  handle: `opaque_${"c".repeat(16)}`,
} as const;
const selectedReceipt = {
  ...selectedTarget,
  version: "spawnfile.target-resource.selected-target.v1",
} as const;
const roots: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-journal-branches-")));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const key = (index: number): string => `idem_${index.toString(36).padStart(16, "a")}`;
const handle = (index: number): string => `opaque_${index.toString(36).padStart(16, "a")}`;
const request = (changes: Record<string, unknown> = {}) => ({
  descriptor_digest: descriptorDigest,
  expected_revision: 0,
  idempotency_key: key(1),
  operation: "create_data_network",
  run_id: "run-one",
  selected_target: selectedTarget,
  version: TARGET_RESOURCE_REQUEST_VERSION,
  ...changes,
});
const receipt = (
  claim: TargetJournalClaim,
  revision: number,
  changes: Record<string, unknown> = {},
) => {
  const value = {
    cleanup_state: "not_requested",
    descriptor_digest: descriptorDigest,
    export_state: "not_requested",
    labels: [],
    operation: "create_data_network",
    operation_handle: claim.operationHandle,
    receipt_digest: descriptorDigest,
    request_digest: claim.requestDigest,
    result_handle: handle(revision),
    resulting_revision: revision,
    run_id: "run-one",
    selected_target: selectedTarget,
    version: TARGET_RESOURCE_RECEIPT_VERSION,
    ...changes,
  };
  return { ...value, receipt_digest: createTargetReceiptDigest(value) };
};
const open = async (root: string): Promise<TargetJournalStore> => initializeTargetJournal({
  context: "production",
  descriptorDigest,
  root,
  runId: "run-one",
  selectedTarget: selectedReceipt,
});
const recordPath = async (root: string): Promise<string> => path.join(
  root,
  (await readdir(root)).find((entry) => entry.endsWith(".json"))!,
);
const expectFailure = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    code: "runtime_error",
    message: "Target journal failed",
  });
};
const own = async (
  journal: TargetJournalStore,
  value = request(),
): Promise<TargetJournalClaim> => {
  const reservation = await journal.reserve(value);
  expect(reservation.kind).toBe("owner");
  if (reservation.kind !== "owner") throw new Error("expected owner reservation");
  return reservation.claim;
};
const seed = async (state: "completed" | "pending") => {
  const root = await createRoot();
  const journal = await open(root);
  const claim = await own(journal);
  if (state === "completed") await journal.complete(claim, receipt(claim, 1));
  const file = await recordPath(root);
  return { claim, file, journal, root };
};
const finish = async (
  journal: TargetJournalStore,
  changes: Record<string, unknown>,
  resultHandle: string | null,
): Promise<TargetJournalClaim> => {
  const revision = (await journal.read()).revision + 1;
  const value = request({
    expected_revision: revision - 1,
    idempotency_key: key(revision),
    ...changes,
  });
  const claim = await own(journal, value);
  await journal.complete(claim, receipt(claim, revision, {
    operation: value.operation,
    result_handle: resultHandle,
  }));
  return claim;
};
type Stored = {
  adapter: Record<string, unknown>;
  claims: Array<Record<string, unknown>>;
  journal: { entries: Array<Record<string, unknown>>; revision: number };
  version: string;
};

const corrupt = async (
  state: "completed" | "pending",
  mutate: (stored: Stored) => unknown,
): Promise<void> => {
  const { file, journal } = await seed(state);
  const stored = JSON.parse(await readFile(file, "utf8")) as Stored;
  const replacement = mutate(stored);
  await writeFile(file, JSON.stringify(replacement === undefined ? stored : replacement), "utf8");
  await expectFailure(journal.read());
};

describe("target journal private-state validation branches", () => {
  it("rejects malformed envelopes, adapters, claims, and journal correlations", async () => {
    const cases: Array<["completed" | "pending", (stored: Stored) => unknown]> = [
      ["pending", () => null],
      ["pending", () => []],
      ["pending", (stored) => { stored.adapter = {}; }],
      ["pending", (stored) => { stored.adapter = { context: 7 }; }],
      ["pending", (stored) => { stored.adapter = { context: "UPPER" }; }],
      ["pending", (stored) => { stored.claims[0] = "sentinel" as unknown as Record<string, unknown>; }],
      ["pending", (stored) => { stored.claims[0]!.idempotency_key = 7; }],
      ["pending", (stored) => { stored.claims[0]!.idempotency_key = "bad"; }],
      ["pending", (stored) => { stored.claims[0]!.operation = 7; }],
      ["pending", (stored) => { stored.claims[0]!.request_digest = "bad"; }],
      ["pending", (stored) => { stored.claims[0]!.state = "unknown"; }],
      ["pending", (stored) => { stored.claims[0]!.receipt_bytes = 7; }],
      ["pending", (stored) => { stored.claims[0]!.operation = "create_evidence_volume"; }],
      ["pending", (stored) => { stored.claims = []; }],
      ["pending", (stored) => { stored.journal.entries[0]!.receipt_digest = descriptorDigest; }],
      ["pending", (stored) => { stored.claims[0]!.receipt_bytes = "{}"; }],
      ["completed", (stored) => { delete stored.claims[0]!.receipt_bytes; }],
      ["completed", (stored) => { stored.claims[0]!.receipt_bytes = "{"; }],
      ["completed", (stored) => { stored.journal.revision = 0; }],
    ];
    for (const [state, mutate] of cases) await corrupt(state, mutate);
  });

  it("rejects duplicate private claim identities and a non-final pending claim", async () => {
    for (const mode of ["idempotency", "handle", "pending-not-final"] as const) {
      const root = await createRoot();
      const journal = await open(root);
      const first = await own(journal);
      await journal.complete(first, receipt(first, 1));
      const secondRequest = request({ expected_revision: 1, idempotency_key: key(2) });
      const second = await own(journal, secondRequest);
      await journal.complete(second, receipt(second, 2));
      const file = await recordPath(root);
      const stored = JSON.parse(await readFile(file, "utf8")) as Stored;
      if (mode === "idempotency") {
        stored.claims[1]!.idempotency_key = stored.claims[0]!.idempotency_key;
      } else if (mode === "handle") {
        stored.claims[1]!.operation_handle = stored.claims[0]!.operation_handle;
        stored.journal.entries[1]!.operation_handle = stored.journal.entries[0]!.operation_handle;
      } else {
        stored.claims[0]!.state = "pending";
        delete stored.claims[0]!.receipt_bytes;
        stored.journal.entries[0]!.state = "pending";
        stored.journal.entries[0]!.receipt_digest = createPendingReceiptDigest(
          stored.claims[0]!.operation_handle,
          stored.claims[0]!.request_digest,
        );
        stored.journal.revision = 1;
      }
      await writeFile(file, JSON.stringify(stored), "utf8");
      await expectFailure(journal.read());
    }
  });

  it("fails closed on malformed public inputs and missing owner state", async () => {
    const root = await createRoot();
    for (const options of [
      { context: 7, descriptorDigest, root, runId: "run-one", selectedTarget: selectedReceipt },
      { context: "production", descriptorDigest: "bad", root, runId: "run-one", selectedTarget: selectedReceipt },
      { context: "UPPER", descriptorDigest, root, runId: "run-one", selectedTarget: selectedReceipt },
    ]) await expectFailure(initializeTargetJournal(options));

    const journal = await open(root);
    await expectFailure(journal.reserve(null));
    await expectFailure(journal.complete({ operationHandle: "bad" as never, requestDigest: descriptorDigest }, {}));
    const claim = await own(journal);
    await expectFailure(journal.complete(claim, null));
    await unlink(await recordPath(root));
    await expectFailure(journal.read());
  });

  it("returns not-applied for a different valid identity in an existing root", async () => {
    const root = await createRoot();
    await open(root);
    for (const options of [
      { context: 7, descriptorDigest },
      { context: "production", descriptorDigest: "bad" },
      { context: "UPPER", descriptorDigest },
    ]) await expectFailure(openExistingTargetJournal({
      ...options,
      root,
      runId: "run-one",
      selectedTarget: selectedReceipt,
    }));
    await expect(lookupTargetOperation({
      context: "production",
      request: request({ run_id: "run-two" }),
      root,
    })).resolves.toMatchObject({ status: "not_applied" });
    await expectFailure(openExistingTargetJournal({
      context: "production",
      descriptorDigest,
      root,
      runId: "run-two",
      selectedTarget: selectedReceipt,
    }));
    await expectFailure(lookupTargetOperation({
      context: "UPPER",
      request: request(),
      root,
    }));
  });

  it("validates every multi-resource provenance shape, including optional cleanup handles", async () => {
    const root = await createRoot();
    const journal = await open(root);
    const network = handle(20);
    const evidence = handle(21);
    const secrets = handle(22);
    const artifact = handle(23);
    const attachment = handle(24);
    const world = handle(25);
    await finish(journal, { operation: "create_data_network" }, network);
    await finish(journal, { operation: "create_evidence_volume" }, evidence);
    await finish(journal, {
      bindings: [{ name: "world", scope: "runtime", source_handle: handle(90) }],
      operation: "prepare_secret_bindings",
    }, secrets);
    await finish(journal, {
      artifact_manifest_digest: descriptorDigest,
      operation: "resolve_world_artifact",
    }, artifact);
    await finish(journal, {
      data_network_handle: network,
      operation: "attach_organization",
      organization_handoff_handle: handle(91),
    }, attachment);
    await finish(journal, {
      data_network_handle: network,
      evidence_mount_path: "/run/world/evidence",
      evidence_volume_handle: evidence,
      operation: "create_world_service",
      secret_bindings_handle: secrets,
      world_artifact_handle: artifact,
    }, world);
    await finish(journal, {
      data_network_handle: network,
      operation: "detach_organization",
      organization_attachment_handle: attachment,
    }, null);
    await finish(journal, {
      operation: "revoke_secret_bindings",
      secret_bindings_handle: secrets,
    }, null);
    await finish(journal, {
      cleanup_policy: "preserve_evidence",
      evidence_volume_handle: evidence,
      operation: "cleanup_run",
      organization_attachment_handle: attachment,
      secret_bindings_handle: secrets,
      world_service_handle: world,
    }, null);

    const emptyRoot = await createRoot();
    const emptyJournal = await open(emptyRoot);
    await expect(finish(emptyJournal, {
      cleanup_policy: "remove",
      operation: "cleanup_run",
    }, null)).resolves.toBeDefined();
  });

  it("fails closed on missing claims and request correlation drift", async () => {
    const root = await createRoot();
    const journal = await open(root);
    const completed = await finish(journal, { operation: "create_data_network" }, handle(30));
    const missing = {
      operationHandle: handle(99) as TargetJournalClaim["operationHandle"],
      requestDigest: completed.requestDigest,
    };
    await expect(journal.resolveCompletedReceipt(missing)).resolves.toBeNull();
    await expectFailure(journal.resolveCompletedReceipt({
      operationHandle: "bad" as never,
      requestDigest: completed.requestDigest,
    }));
    await expectFailure(journal.resolveCompletedReceipt({
      operationHandle: completed.operationHandle,
      requestDigest: "bad" as never,
    }));
    await expectFailure(journal.complete(missing, receipt(missing, 2)));

    for (const drift of [
      { run_id: "run-two" },
      { descriptor_digest: `sha256:${"d".repeat(64)}` },
      { selected_target: { ...selectedTarget, fingerprint: `sha256:${"e".repeat(32)}` } },
    ]) await expectFailure(journal.reserve(request({
      expected_revision: 1,
      idempotency_key: key(8),
      ...drift,
    })));

    const lookup = await openExistingTargetJournal({
      context: "production",
      descriptorDigest,
      root,
      runId: "run-one",
      selectedTarget: selectedReceipt,
    });
    await expectFailure(lookup.lookup(null));
  });

  it("distinguishes pending and completed resolution and rejects lookup correlation drift", async () => {
    const pending = await seed("pending");
    await expect(pending.journal.resolveCompletedReceipt(pending.claim)).resolves.toBeNull();
    const completed = await seed("completed");
    await expect(completed.journal.resolveCompletedReceipt(completed.claim)).resolves.toMatchObject({
      receipt: { operation_handle: completed.claim.operationHandle },
    });
    const lookup = await openExistingTargetJournal({
      context: "production",
      descriptorDigest,
      root: completed.root,
      runId: "run-one",
      selectedTarget: selectedReceipt,
    });
    for (const drift of [
      { run_id: "run-two" },
      { descriptor_digest: `sha256:${"d".repeat(64)}` },
      { selected_target: { ...selectedTarget, fingerprint: `sha256:${"e".repeat(32)}` } },
    ]) await expectFailure(lookup.lookup(request({ ...drift })));
    await unlink(completed.file);
    await expectFailure(completed.journal.resolveCompletedReceipt(completed.claim));
  });
});
