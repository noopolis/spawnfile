import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const source = mkdtempSync(path.join(os.tmpdir(), "spawnfile-product-volume-"));
const volume = `spawnfile-product-preseed-${process.pid}`;
const rollbackVolume = `${volume}-rollback`;
const cleanupVolume = `${volume}-cleanup`;
const container = `spawnfile-product-preseed-${process.pid}`;
const run = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
const runCliAuthorityClone = () => {
  if (process.platform !== "linux") return;
  const sourceVolume = `${volume}-authority-source`, candidateVolume = `${volume}-authority-candidate`, sourceContainer = `${container}-authority`, authority = path.join(source, "authority.json"), proof = path.join(source, "proof.json"), authorityRequest = path.join(source, "authority-request.json"), cloneRequest = path.join(source, "clone-request.json"), cloneReceipt = path.join(source, "clone-receipt.json");
  try {
    run(["volume", "create", sourceVolume]); run(["volume", "create", candidateVolume]);
    run(["run", "-d", "--name", sourceContainer, "--label", "com.spawnfile.run_id=live-cli", "-v", `${sourceVolume}:/product`, "alpine:3.22", "sleep", "300"]);
    run(["exec", sourceContainer, "sh", "-c", "printf cli-edition >/product/edition.json"]); run(["run", "--rm", "-v", `${candidateVolume}:/candidate`, "alpine:3.22", "chmod", "0777", "/candidate"]);
    const destination = JSON.parse(run(["volume", "inspect", candidateVolume]))[0].Mountpoint, startedAt = JSON.parse(run(["inspect", sourceContainer]))[0].State.StartedAt;
    writeFileSync(authorityRequest, `${JSON.stringify({ version: "spawnfile.product-state-source-authority-request.v1", docker_command: "docker", container: sourceContainer, source_run_id: "live-cli", mount_path: "/product", candidate_volume_name: candidateVolume, candidate_resource_identity: `sha256:${"d".repeat(64)}`, receipt_path: authority, proof_path: proof })}\n`);
    execFileSync("node", ["dist/cli/index.js", "product-state", "authority", authorityRequest], { cwd: root, stdio: "pipe" });
    const after = JSON.parse(run(["inspect", sourceContainer]))[0]; if (after.State.Paused || after.State.StartedAt !== startedAt) throw new Error("authority did not restore the exact running source");
    writeFileSync(cloneRequest, `${JSON.stringify({ version: "spawnfile.product-state-clone-request.v1", authority_receipt_path: authority, docker_command: "docker", destination, proof_path: proof, receipt_path: cloneReceipt, candidate_run_id: "candidate-cli" })}\n`);
    execFileSync("node", ["dist/cli/index.js", "product-state", "clone", cloneRequest], { cwd: root, stdio: "pipe" });
    run(["run", "--rm", "-v", `${candidateVolume}:/candidate:ro`, "alpine:3.22", "sh", "-eu", "-c", "test \"$(cat /candidate/edition.json)\" = cli-edition; test -s /candidate/.spawnfile-resource-identity"]);
  } finally { try { run(["rm", "-f", sourceContainer]); } catch {} try { run(["volume", "rm", "-f", sourceVolume]); } catch {} try { run(["volume", "rm", "-f", candidateVolume]); } catch {} }
};
try {
  writeFileSync(path.join(source, "edition.json"), "edition");
  mkdirSync(path.join(source, "nested")); writeFileSync(path.join(source, "nested", "index.json"), "index");
  run(["volume", "create", volume]); run(["volume", "create", rollbackVolume]); run(["volume", "create", cleanupVolume]);
  const program = `import{createHash}from"node:crypto";import{mkdir,writeFile}from"node:fs/promises";import{cloneQuiescedProductState}from"/app/dist/deployment/productStateClone.js";const h=x=>"sha256:"+createHash("sha256").update(x).digest("hex"),proof={version:"spawnfile.product-state-quiescence.v1",state:"quiesced",source_run_id:"live",files:[{path:"edition.json",sha256:h("edition")},{path:"nested/index.json",sha256:h("index")}]};await cloneQuiescedProductState({source:"/source",destination:"/dest",proof,candidateRunId:"candidate"});await mkdir("/rollback/.spawnfile-preseed-crash");await writeFile("/rollback/edition.json","partial");await writeFile("/rollback/.spawnfile-product-state-preseed-journal",JSON.stringify({version:"spawnfile.product-state-preseed-journal.v1",candidate_run_id:"recovery",entries:["edition.json"],staging:".spawnfile-preseed-crash"}));await cloneQuiescedProductState({source:"/source",destination:"/rollback",proof,candidateRunId:"recovery"});let failed=false;try{await cloneQuiescedProductState({source:"/source",destination:"/cleanup",proof:{...proof,files:[{...proof.files[0],sha256:"sha256:"+"0".repeat(64)}]},candidateRunId:"cleanup"})}catch{failed=true}if(!failed)process.exit(2);`;
  run(["create", "--name", container, "-v", `${volume}:/dest`, "-v", `${rollbackVolume}:/rollback`, "-v", `${cleanupVolume}:/cleanup`, "node:22-bookworm-slim", "sleep", "300"]); run(["start", container]); run(["exec", container, "mkdir", "-p", "/app"]);
  run(["cp", path.join(root, "dist"), `${container}:/app/dist`]); run(["cp", path.join(root, "node_modules"), `${container}:/app/node_modules`]); run(["cp", source, `${container}:/source`]);
  run(["exec", "-w", "/app", container, "node", "--input-type=module", "-e", program]);
  run(["run", "--rm", "-v", `${volume}:/dest:ro`, "alpine:3.22", "sh", "-eu", "-c", "test \"$(cat /dest/edition.json)\" = edition; test \"$(cat /dest/nested/index.json)\" = index; test \"$(find /dest -type f | wc -l)\" -eq 2"]);
  run(["run", "--rm", "-v", `${rollbackVolume}:/rollback:ro`, "alpine:3.22", "sh", "-eu", "-c", "test \"$(cat /rollback/edition.json)\" = edition; test \"$(cat /rollback/nested/index.json)\" = index; test ! -e /rollback/.spawnfile-product-state-preseed-journal"]);
  run(["run", "--rm", "-v", `${cleanupVolume}:/cleanup:ro`, "alpine:3.22", "sh", "-eu", "-c", "test \"$(find /cleanup -mindepth 1 -maxdepth 1 | wc -l)\" -eq 0"]);
  runCliAuthorityClone();
  console.log("PASS product-state named-volume preseed");
} finally {
  try { run(["rm", "-f", container]); } catch {}
  try { run(["volume", "rm", "-f", volume]); } catch {}
  try { run(["volume", "rm", "-f", rollbackVolume]); } catch {}
  try { run(["volume", "rm", "-f", cleanupVolume]); } catch {}
  rmSync(source, { recursive: true, force: true });
}
