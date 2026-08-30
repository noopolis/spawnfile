import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { issueDeploymentIdentity, runCanaryCutover, verifyEquivalentRollbackReadiness } from "../deployment/canaryCutover.js";

const boundedArgs = z.array(z.string().max(4096)).max(32);
const request = z.object({ version: z.literal("spawnfile.canary-cutover-request.v1"), live_report_path: z.string().min(1), candidate_report_path: z.string().min(1), readiness_path: z.string().min(1), expected_identity: z.unknown(), docker_command: z.string().min(1), nonce: z.string().regex(/^[a-f0-9]{32}$/u), transaction_path: z.string().min(1), ingress_command: z.string().min(1), ingress_args: boundedArgs, ingress_receipt_path: z.string().min(1), teardown_command: z.string().min(1), teardown_args: boundedArgs, teardown_policy: z.enum(["export", "force"]), teardown_project_path: z.string().min(1), teardown_compiled_path: z.string().min(1), decision_receipt_path: z.string().min(1), from_deployment: z.string().min(1), to_deployment: z.string().min(1) }).strict();
const rollback = z.object({ version: z.literal("spawnfile.canary-rollback-readiness-request.v1"), rollback_readiness_path: z.string().min(1), expected_identity: z.unknown() }).strict();
const identity = z.object({ version: z.literal("spawnfile.deployment-identity-request.v1"), readiness_path: z.string().min(1), deployment_mode: z.enum(["project", "image"]), docker_command: z.string().min(1), receipt_path: z.string().min(1) }).strict();
export const isCanaryCutoverInvocation = (argv: readonly string[]): boolean => argv[0] === "canary" && ["identity", "cutover", "verify-rollback"].includes(argv[1] ?? "");
export const runCanaryCutoverCommand = async (argv: readonly string[]): Promise<number> => { try {
  const bytes = await readFile(argv[2] ?? "", "utf8");
  if (argv[1] === "identity") { const value = identity.parse(JSON.parse(bytes)), receipt = await issueDeploymentIdentity(value.readiness_path, value.deployment_mode, value.docker_command); await writeFile(value.receipt_path, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 }); }
  else if (argv[1] === "verify-rollback") { const value = rollback.parse(JSON.parse(bytes)); await verifyEquivalentRollbackReadiness(value.rollback_readiness_path, value.expected_identity); }
  else { const value = request.parse(JSON.parse(bytes)); await runCanaryCutover({ liveReportPath: value.live_report_path, candidateReportPath: value.candidate_report_path, readinessPath: value.readiness_path, expectedIdentity: value.expected_identity, dockerCommand: value.docker_command, nonce: value.nonce, transactionPath: value.transaction_path, ingressCommand: value.ingress_command, ingressArgs: value.ingress_args, ingressReceiptPath: value.ingress_receipt_path, teardownCommand: value.teardown_command, teardownArgs: value.teardown_args, teardownPolicy: value.teardown_policy, teardownProjectPath: value.teardown_project_path, teardownCompiledPath: value.teardown_compiled_path, decisionReceiptPath: value.decision_receipt_path, fromDeployment: value.from_deployment, toDeployment: value.to_deployment }); }
  return 0;
} catch { process.stderr.write("error: Canary operation failed\n"); return 1; } };
