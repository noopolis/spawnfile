import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DAIMON_GROK_ENGINE_BROKER as broker } from "../../../runtime/daimon/contractManifest.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const run = promisify(execFile);

it("invokes paired-compiler slot preparation through the actual image layout and kills missing compiler and runtime links", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "training-image-layout-"));
  try {
    const prefix = path.join(scratch, "opt/training");
    const recipe = await readFile(path.join(root, "runtime-images/training/Dockerfile"), "utf8");
    const links = [...recipe.matchAll(/ln -s (\/opt\/(?:training\/(?:compiler|spawnfile|paideia)|spawnfile\/runtime-installs\/daimon\/node_modules\/@noopolis\/daimon)) (\/opt\/training\/[^\s\\]+)/gu)];
    const importer = path.join(prefix, "paideia/dist/src/adapters/spawnfile/index.js");
    await mkdir(path.dirname(importer), { recursive: true });
    await writeFile(path.join(prefix, "paideia/package.json"), JSON.stringify({ type: "module" }));
    await writeFile(importer, "export { activateTrainingExecution, prepareTrainingSessionSlot, trainingSlotsDocument, trainingSlotDescriptors } from 'spawnfile/training';\n");
    // Use the real paired public compiler and all its production dependencies, with explicit production dependencies.
    const compiler = path.join(prefix, "compiler"); await mkdir(compiler);
    await cp(path.join(root, "package.json"), path.join(compiler, "package.json"));
    await cp(path.join(root, "src"), path.join(compiler, "src"), { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(compiler, "package.json"), "utf8"));
    manifest.exports["./training"].import = "./src/compiler/training/index.ts";
    await writeFile(path.join(compiler, "package.json"), JSON.stringify(manifest));
    // Reproduce production dependencies without a wholesale node_modules link masking the runtime peer.
    const modules = path.join(compiler, "node_modules"); await mkdir(modules);
    for (const name of Object.keys(manifest.dependencies)) {
      await mkdir(path.dirname(path.join(modules, name)), { recursive: true });
      await symlink(path.join(root, "node_modules", name), path.join(modules, name));
    }
    // Stop Node from finding an optional developer peer above the reconstructed image.
    const fallback = path.join(scratch, "node_modules/@noopolis/daimon");
    await mkdir(fallback, { recursive: true });
    await writeFile(path.join(fallback, "package.json"), JSON.stringify({ exports: { "./runtime": null } }));
    const runtime = path.join(scratch, "opt/spawnfile/runtime-installs/daimon/node_modules/@noopolis/daimon");
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, "package.json"), JSON.stringify({ type: "module", exports: { "./runtime": "./runtime.js" } }));
    // Runtime contract fake; the real slot function must resolve it from its own paired compiler location.
    await writeFile(path.join(runtime, "runtime.js"), `export const GROK_ENGINE_BROKER=${JSON.stringify(broker)};
export function resolveOrganizationGrokBrokerProjection() { return {}; }
export function grokBrokerProjectionSha256() { return 'c'.repeat(64); }`);
    await mkdir(path.join(prefix, "spawnfile"));
    for (const [, target, link] of links) {
      const destination = link!.replace("/opt/training", prefix);
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(path.join(scratch, target!.slice(1)), destination);
    }
    const program = path.join(scratch, "verify.mjs");
    await writeFile(program, `import { activateTrainingExecution, prepareTrainingSessionSlot, trainingSlotsDocument, trainingSlotDescriptors } from ${JSON.stringify(importer)};
if (typeof activateTrainingExecution !== 'function') throw Error('Missing receiver');
const slot=trainingSlotsDocument(1).slots[0], p=trainingSlotDescriptors(1)[0];
const nonce='b'.repeat(64);
const declaration={version:'spawnfile.training-broker.v2',slots:1,engine:'grok',agentId:'agent:writer',model:'grok-4.6',
 reasoningEffort:'low',architecture:'arm64',limits:{maxRequests:20,maxTokens:10000,timeoutMs:120000},
 bootstrap:'/run/paideia-auth/grok-bootstrap/auth.json',organizationUid:2000,seccompProfileSha256:'a'.repeat(64)};
let receipt;
const result=await prepareTrainingSessionSlot({slot,slots:1,signal:new AbortController().signal,expectedNonce:nonce,minGeneration:2},{
 read:async file=>file===${JSON.stringify("/run/paideia/training-broker.json")}?declaration:receipt,
 recycle:async()=>({ok:true,verb:'recycle',slot:0,generation:2,nonce,receipt:p.preflightReceipt,durationMs:1}),
 projection:async(d,r,runtime)=>{
   if(runtime.GROK_ENGINE_BROKER.nativeAbiVersion!==${broker.nativeAbiVersion}) throw Error('Runtime did not load');
   receipt={version:${JSON.stringify(broker.slotPreflightVersion)},slot:0,worker_uid:slot.workerUid,generation:2,nonce,
     projection_sha256:'c'.repeat(64),sandbox_profile_sha256:r.profileSha256,seccomp_profile_sha256:d.seccompProfileSha256,
     grok_executable_sha256:${JSON.stringify(broker.grokCliArtifacts.arm64.sha256)},sandbox_runtime:'bubblewrap',
     canaries:r.denyPaths.map(path=>({path,method:'sandboxed-read',result:'denied'})),created_at:new Date().toISOString()};
   return {projection:{version:runtime.GROK_ENGINE_BROKER.projectionVersion},projectionSha256:'c'.repeat(64)};
 }});
if(result.generation!==2 || result.nonce!==nonce) throw Error('Slot not prepared');
console.log('IMAGE SLOT PREPARED');\n`);
    const options = { cwd: scratch, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000 };
    const argv = ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), program];
    expect((await run(process.execPath, argv, options)).stdout, "image compiler resolution guarantee").toContain("IMAGE SLOT PREPARED");
    const peer = path.join(compiler, "node_modules/@noopolis/daimon");
    await rm(peer);
    await expect(run(process.execPath, argv, options), "image runtime resolution mutation guarantee").rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("The training image must install @noopolis/daimon") });
    await symlink(runtime, peer);
    await rm(path.join(prefix, "paideia/node_modules/spawnfile"));
    await expect(run(process.execPath, argv, options)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ERR_MODULE_NOT_FOUND") });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 40_000);
