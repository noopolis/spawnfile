import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { issueProductStateSourceSnapshot, runProductStateCloneWorkflow } from "../deployment/productStateClone.js";

const requestSchema = z.object({ version: z.literal("spawnfile.product-state-clone-request.v1"), authority_receipt_path: z.string().min(1).max(4096), docker_command: z.string().min(1).max(4096), destination: z.string().min(1).max(4096), proof_path: z.string().min(1).max(4096), receipt_path: z.string().min(1).max(4096), candidate_run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u) }).strict();
const authorityRequestSchema = z.object({ version: z.literal("spawnfile.product-state-source-authority-request.v1"), docker_command: z.string().min(1).max(4096), container: z.string().min(1).max(255), source_run_id: z.string().min(1).max(128), mount_path: z.string().min(1).max(4096), candidate_volume_name: z.string().min(1).max(255), candidate_resource_identity: z.string().regex(/^sha256:[a-f0-9]{64}$/u), receipt_path: z.string().min(1).max(4096), proof_path: z.string().min(1).max(4096) }).strict();
export const isProductStateCloneInvocation = (argv: readonly string[]): boolean => argv[0] === "product-state" && ["authority", "clone"].includes(argv[1] ?? "");
export const runProductStateCloneCommand = async (argv: readonly string[]): Promise<number> => {
  try {
    if (argv.length !== 3) throw new Error("usage");
    const bytes = await readFile(argv[2]!); if (bytes.length > 65_536) throw new Error("oversized");
    if (argv[1] === "authority") {
      const request = authorityRequestSchema.parse(JSON.parse(bytes.toString("utf8"))), snapshot = await issueProductStateSourceSnapshot({ dockerCommand: request.docker_command, container: request.container, sourceRunId: request.source_run_id, mountPath: request.mount_path, candidateVolumeName: request.candidate_volume_name, candidateResourceIdentity: request.candidate_resource_identity });
      await mkdir(path.dirname(request.receipt_path), { recursive: true, mode: 0o700 }); await writeFile(request.proof_path, `${JSON.stringify(snapshot.proof)}\n`, { flag: "wx", mode: 0o600 }); await writeFile(request.receipt_path, `${JSON.stringify(snapshot.authority)}\n`, { flag: "wx", mode: 0o600 }); process.stdout.write(`${JSON.stringify(snapshot.authority)}\n`); return 0;
    }
    const request = requestSchema.parse(JSON.parse(bytes.toString("utf8")));
    process.stdout.write(`${JSON.stringify(await runProductStateCloneWorkflow({ authorityReceiptPath: request.authority_receipt_path, dockerCommand: request.docker_command, destination: request.destination, proofPath: request.proof_path, receiptPath: request.receipt_path, candidateRunId: request.candidate_run_id }))}\n`); return 0;
  } catch { process.stderr.write("error: Product-state clone failed\n"); return 1; }
};
