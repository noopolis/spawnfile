import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
export const receiptPath = (worktree) => path.join(worktree, ".worktree-bootstrap.json");
export const scriptHash = (scriptPath) => createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
export const writeReceipt = ({ worktree, item, sourceCheckout, repos, tiers, scriptPath, layout = "nested" }) => {
  const receipt = { item, timestamp: new Date().toISOString(), sourceCheckout, layout, tiers, repos, scriptSha256: scriptHash(scriptPath) };
  writeFileSync(receiptPath(worktree), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
};
export const readReceipt = (worktree) => existsSync(receiptPath(worktree)) ? JSON.parse(readFileSync(receiptPath(worktree), "utf8")) : null;
export const verifyReceipt = ({ worktree, item }) => {
  const receipt = readReceipt(worktree);
  if (!receipt) return "WORKTREE INCOMPLETE: " + path.resolve(worktree) + " has no .worktree-bootstrap.json receipt.";
  if (item && receipt.item !== item) return "WORKTREE INVALID: " + path.resolve(worktree) + " receipt item is " + receipt.item + ", expected " + item + ".";
  return null;
};
export const tiersFromReceipt = (receipt) => Array.isArray(receipt?.tiers) && receipt.tiers.length ? receipt.tiers : ["suite"];
