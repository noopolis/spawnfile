import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const control = vi.hoisted(()=>({ failWrite:false, mutateSource:false, growSource:false }));
vi.mock("node:fs/promises",async(importOriginal)=>{
 const native=await importOriginal<typeof import("node:fs/promises")>();
 return {...native,realpath:async(...args:Parameters<typeof native.realpath>)=>{
   if(String(args[0]).startsWith("/run/paideia-auth/")) throw Error("fixed ingress intercepted for test: "+args[0]);
   return native.realpath(...args);
 },open:async(...args:Parameters<typeof native.open>)=>{
   const file=await native.open(...args);
   if(String(args[0]).includes(".stage-") && control.failWrite) file.writeFile=async()=>{throw Error("injected disk full");};
   if(!String(args[0]).includes(".stage-") && control.growSource) {
     const original=file.read.bind(file);file.read=(async(...readArgs:unknown[])=>{const buffer=readArgs[0] as Buffer;buffer.fill(120);return {bytesRead:buffer.length,buffer};}) as typeof original;
   }
   if(!String(args[0]).includes(".stage-") && control.mutateSource){const original=file.stat.bind(file);let calls=0;file.stat=(async(options:unknown)=>{const value=await original(options as {bigint:true});if(++calls===2)value.ctimeNs+=1n;return value;}) as typeof file.stat;}
   return file;
 }};
});
import {stageTrainingAuth} from "./trainingAuth.js";
const roots:string[]=[];
afterEach(async()=>{control.failWrite=false;control.mutateSource=false;control.growSource=false;for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const setup=async()=>{const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"training-auth-failure-")));roots.push(root);const home=path.join(root,"home"),source=path.join(root,"source");await mkdir(home,{mode:0o700});await writeFile(source,"complete-fake-credential");return {home,source,provider:"codex" as const};};
it("never publishes a partial credential and allows a clean retry after write failure",async()=>{
 const f=await setup();control.failWrite=true;await expect(stageTrainingAuth(f)).rejects.toThrow("disk full");expect(await readdir(path.join(f.home,".daimon-inbound"))).toEqual([]);
 control.failWrite=false;const receipt=await stageTrainingAuth(f);expect(await readFile(receipt.destination,"utf8")).toBe("complete-fake-credential");
});
it("rejects even a nanosecond source identity change before publication",async()=>{
 const f=await setup();control.mutateSource=true;await expect(stageTrainingAuth(f)).rejects.toThrow("changed during staging");expect(await readdir(path.join(f.home,".daimon-inbound"))).toEqual([]);
});

it("bounds an unexpectedly growing source to the preallocated limit",async()=>{
 const f=await setup();control.growSource=true;await expect(stageTrainingAuth(f)).rejects.toThrow("changed during staging");expect(await readdir(path.join(f.home,".daimon-inbound"))).toEqual([]);
});
it("selects the fixed default ingress without opening real credentials",async()=>{
 const f=await setup();await expect(stageTrainingAuth({home:f.home,provider:"codex"})).rejects.toThrow("fixed ingress intercepted for test: /run/paideia-auth/codex");
});
