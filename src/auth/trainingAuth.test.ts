import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stageTrainingAuth, type TrainingAuthProvider } from "./trainingAuth.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
const setup = async () => { const root = await realpath(await mkdtemp(path.join(os.tmpdir(),"spawnfile-training-auth-")));roots.push(root);const home=path.join(root,"home"),source=path.join(root,"auth");await mkdir(home,{mode:0o700});await writeFile(source,"opaque-fixture-only");return {root,home,source}; };
it.each(["codex","grok","claude"] as const)("stages only %s auth to its native private leaf without overwriting renewal",async(provider)=>{
 const f=await setup();const receipt=await stageTrainingAuth({...f,provider});
 expect(receipt.version).toBe("spawnfile.training-auth-stage.v1");expect(await readFile(receipt.destination,"utf8")).toBe("opaque-fixture-only");expect((await stat(receipt.destination)).mode&0o777).toBe(0o600);
 await writeFile(receipt.destination,"renewed");await expect(stageTrainingAuth({...f,provider})).rejects.toThrow("renewed credential preserved");expect(await readFile(receipt.destination,"utf8")).toBe("renewed");
});
it("rejects source and destination symlinks, nonprivate ingress, directories and empty/oversized leaves",async()=>{
 const f=await setup(),alias=path.join(f.root,"alias");await symlink(f.source,alias);
 for(const source of [alias,f.home]) await expect(stageTrainingAuth({...f,source,provider:"codex"})).rejects.toThrow();
 for(const bytes of ["","x".repeat(1024*1024+1)]){await writeFile(f.source,bytes);await expect(stageTrainingAuth({...f,provider:"codex"})).rejects.toThrow();}
 await writeFile(f.source,"fixture");await symlink(f.home,path.join(f.home,".daimon-inbound"));await expect(stageTrainingAuth({...f,provider:"codex"})).rejects.toThrow("private and canonical");
 await rm(path.join(f.home,".daimon-inbound"));await mkdir(path.join(f.home,".daimon-inbound"));await chmod(path.join(f.home,".daimon-inbound"),0o755);await expect(stageTrainingAuth({...f,provider:"codex"})).rejects.toThrow("private");
 await expect(stageTrainingAuth({...f,provider:"other" as TrainingAuthProvider})).rejects.toThrow("Unsupported");
 await expect(stageTrainingAuth({...f,home:"relative",provider:"codex"})).rejects.toThrow("canonical");
});
