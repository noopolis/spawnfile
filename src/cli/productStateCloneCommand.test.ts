import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { clone } = vi.hoisted(() => ({ clone: vi.fn(async () => ({ version: "spawnfile.product-state-clone-receipt.v1" })) }));
vi.mock("../deployment/productStateClone.js", () => ({ issueProductStateSourceSnapshot: vi.fn(), runProductStateCloneWorkflow: clone }));
import { isProductStateCloneInvocation, runProductStateCloneCommand } from "./productStateCloneCommand.js";

afterEach(() => vi.restoreAllMocks());
describe("product-state clone CLI", () => {
  it("routes one strict request and fails closed on malformed invocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-clone-cli-")); try {
      const request = path.join(root, "request.json"); await writeFile(request, JSON.stringify({ version: "spawnfile.product-state-clone-request.v1", authority_receipt_path: "/authority", docker_command: "docker", destination: "/candidate", proof_path: "/proof", receipt_path: "/receipt", candidate_run_id: "candidate" }));
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true); const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(isProductStateCloneInvocation(["product-state", "clone", request])).toBe(true); expect(isProductStateCloneInvocation(["compile"])).toBe(false);
      await expect(runProductStateCloneCommand(["product-state", "clone", request])).resolves.toBe(0); expect(clone).toHaveBeenCalledWith({ authorityReceiptPath: "/authority", dockerCommand: "docker", destination: "/candidate", proofPath: "/proof", receiptPath: "/receipt", candidateRunId: "candidate" }); expect(stdout).toHaveBeenCalled();
      await expect(runProductStateCloneCommand(["product-state", "clone"])).resolves.toBe(1); expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^error: Product-state clone failed: /u));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
