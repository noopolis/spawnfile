import path from "node:path";

import {
  findLifecycleOutcomeEvidence,
  createDeploymentInstanceDigest,
  readDeploymentRecord,
  resolveDeploymentRecordPath,
} from "../deployment/index.js";
import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, REPORT_FILENAME } from "../shared/index.js";
import { readUtf8File } from "../filesystem/index.js";

import type { LifecycleReconciliation } from "./lifecycleMachine.js";
import type { UpLifecycleOptions } from "./upLifecycleInvocation.js";

const ambiguous = (reason: string): LifecycleReconciliation => ({
  reason,
  status: "ambiguous",
});

const exactHandoff = (
  record: Awaited<ReturnType<typeof readDeploymentRecord>>,
  options: UpLifecycleOptions,
): boolean =>
  record.organization_handoff !== undefined &&
  record.organization_handoff_handle !== undefined &&
  record.organization_handoff.network_attachment_handle ===
    options.networkAttachmentHandle &&
  record.organization_handoff.selected_target_receipt_digest ===
    options.selectedTargetReceiptDigest;

export const reconcileUpLifecycle = async (
  inputPath: string,
  options: UpLifecycleOptions,
  invocation: Parameters<typeof findLifecycleOutcomeEvidence>[0],
): Promise<LifecycleReconciliation> => {
  const outputDirectory = resolveProjectOutputDirectory(
    inputPath,
    options.out,
    DEFAULT_OUTPUT_DIRECTORY,
  );
  const deployment = options.deployment;
  if (!deployment) return ambiguous("up_deployment_not_bound");
  const recordPath = resolveDeploymentRecordPath(outputDirectory, deployment);

  try {
    const record = await readDeploymentRecord(recordPath);
    const report = JSON.parse(
      await readUtf8File(path.join(outputDirectory, REPORT_FILENAME)),
    ) as CompileReport;
    const requestedRoot = path.resolve(inputPath);
    if (
      record.name !== deployment ||
      record.output_directory !== outputDirectory ||
      record.source.kind !== "project" ||
      path.resolve(record.source.root) !== requestedRoot ||
      record.compile_fingerprint !== report.compile_fingerprint ||
      record.auth_profile !== (options.authProfile ?? null) ||
      (options.context !== undefined &&
        (record.target.kind !== "context" ||
          record.target.name !== options.context)) ||
      (options.name !== undefined &&
        record.units[0]?.container_name !== options.name) ||
      !exactHandoff(record, options)
    )
      return ambiguous("up_durable_evidence_drifted");

    const evidence = await findLifecycleOutcomeEvidence(invocation);
    if (!evidence) return ambiguous("up_receipt_evidence_absent");
    if (
      evidence.deployment_instance_digest !==
      createDeploymentInstanceDigest(record)
    )
      return ambiguous("up_deployment_instance_changed");
    return {
      outcomeBytes: evidence.completion.outcome_bytes,
      status: "completed",
    };
  } catch {
    return ambiguous("up_durable_evidence_absent_or_invalid");
  }
};
