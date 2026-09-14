import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, dockerFixture, image, id } from "./fixtures.test-helper.js";
import { launchTrainingContainer } from "./launch.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const setup = async () => { const value = await fixture(); roots.push(value.root); return value; };
const streams = () => ({ stdout: vi.fn(), stderr: vi.fn() });
it("launches one immutable container, streams a verified persisted completion and removes only its verified identity", async () => {
  const f = await setup(); let observedContext: unknown;
  const docker = dockerFixture(async (args) => {
    if (args[2] === "create") {
      const mount = args.find((entry) => entry.includes("dst=/run/paideia/context.json"))!;
      observedContext = JSON.parse(await readFile(mount.split("src=")[1]!.split(",")[0]!, "utf8"));
    }
    return undefined;
  }); const output = streams();
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 1000, streams: output, process: docker.process })).toBe(0);
  expect(observedContext).toMatchObject({ project: { root: "/run/training/inputs/project" } });
  const create = docker.calls.find((args) => args[2] === "create")!;
  expect(create).toContain("/opt/training/bin/train"); expect(create).toContain("HOME=/home/training");
  expect(create).toContain("--user"); expect(create).toContain(`${process.getuid!()}:${process.getgid!()}`);
  expect(create).toContain("--security-opt=seccomp=unconfined"); expect(create).toContain("--security-opt=apparmor=unconfined");
  expect(create.some((value) => value.startsWith("/work:") && value.includes(`uid=${process.getuid!()}`))).toBe(true);
  expect(create).toContain(image); expect(create).not.toContain("--privileged");
  expect(create.join(" ")).not.toContain("docker.sock");
  expect(create.join(" ")).toContain("dst=/run/paideia-auth/grok,readonly");
  expect(output.stdout).toHaveBeenLastCalledWith('{"status":"completed","index":"/run/training/output/index.json"}');
  expect(docker.calls.some((args) => args[2] === "rm" && args.at(-1) === id)).toBe(true);
});
it("rejects remote contexts and missing images before container creation", async () => {
  const f = await setup();
  for (const remote of [true, false]) {
    const docker = dockerFixture(async (args) => args[0] === "context" && remote ? {code:0,stdout:'"ssh://host"',stderr:""} : args[2] === "image" ? {code:1,stdout:"",stderr:""}: undefined);
    await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:docker.process})).rejects.toThrow();
    expect(docker.calls.some((args) => args[2] === "create")).toBe(false);
  }
});
it("rejects malformed completion, missing artifact, running state and inconsistent exit evidence", async () => {
  const f = await setup();
  for (const text of ["not json", '{"status":"completed","index":"/etc/passwd"}', '{"status":"completed","index":"/run/training/output/missing.json"}', '{"status":"pending","index":"/run/training/output/index.json"}']) {
    const docker = dockerFixture(async (args, options) => { if (args[2] === "start") {options.stdout?.(text);return {code:0,stdout:"",stderr:""};} return undefined; });
    await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:docker.process})).rejects.toThrow();
    expect(docker.calls.some((args) => args[2] === "rm")).toBe(true);
  }
  for (const state of [{Running:true,ExitCode:0},{Running:false,ExitCode:1}]) {
    const docker = dockerFixture(async (args) => args[4] === "{{json .State}}" ? {code:0,stdout:JSON.stringify(state),stderr:""}:undefined);
    await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:docker.process})).rejects.toThrow("final state");
  }
});
it("refuses foreign ownership and reports unverified cleanup", async () => {
  const f = await setup();
  const foreign = dockerFixture(async (args) => args[2] === "inspect" ? { code:0,stdout:[id,"/foreign",image,{}].map((value) => JSON.stringify(value)).join("\n"),stderr:"" }:undefined);
  await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:foreign.process})).rejects.toThrow();
  expect(foreign.calls.some((args) => args[2] === "rm")).toBe(false);
  const failed = dockerFixture(async (args) => args[2] === "container" ? {code:0,stdout:id,stderr:""}:undefined);
  await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:failed.process})).rejects.toThrow("cleanup is unverified");
});
it("cancellation and deadlines stop the real owned container, including a lost create response", async () => {
  const f = await setup();
  for (const phase of ["create", "start"]) {
    const controller = new AbortController();
    const docker = dockerFixture(async (args) => { if (args[2] === phase) { controller.abort(); if (phase === "start") throw Error("cancelled"); } return undefined; });
    expect(await launchTrainingContainer({...f,image,timeoutMs:1000,signal:controller.signal,streams:streams(),process:docker.process})).toBe(130);
    expect(docker.calls.some((args) => args[2] === "rm")).toBe(true);
  }
  const docker = dockerFixture(async (args, options) => {
    if (args[2] === "start") await new Promise<void>((_resolve,reject) => options.signal!.addEventListener("abort",()=>reject(Error("deadline")),{once:true}));
    return undefined;
  });
  await expect(launchTrainingContainer({...f,image,timeoutMs:50,streams:streams(),process:docker.process})).rejects.toThrow("deadline");
  expect(docker.calls.some((args) => args[2] === "rm")).toBe(true);
  const already = new AbortController();already.abort();
  expect(await launchTrainingContainer({...f,image,timeoutMs:1000,signal:already.signal,streams:streams(),process:docker.process})).toBe(130);
});
it("refuses oversized launch configuration", async () => {
  const f = await setup();await writeFile(f.configPath," ".repeat(1024*1024+1));
  await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams()})).rejects.toThrow("1 MiB");
});
it("preserves non-success exit codes and proves absence when create leaves no container", async () => {
  const f = await setup();
  const exited = dockerFixture(async (args) => args[2] === "start" ? {code:2,stdout:"",stderr:""} : args[4] === "{{json .State}}" ? {code:0,stdout:'{"Running":false,"ExitCode":2}',stderr:""}:undefined);
  expect(await launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:exited.process})).toBe(2);
  for(const remains of ["",id]) {
    const missing = dockerFixture(async (args)=> args[2] === "create" ? {code:1,stdout:"",stderr:""} : args[2] === "inspect" ? {code:1,stdout:"",stderr:""}: args[2] === "container" ? {code:0,stdout:remains,stderr:""}:undefined);
    await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:missing.process})).rejects.toThrow(remains ? "closure is unknown" : "valid training container");
  }
});

it("refuses a root caller before any Docker invocation", async () => {
 const f=await setup(),docker=dockerFixture();const uid=vi.spyOn(process as {getuid:()=>number},"getuid").mockReturnValue(0);
 try { await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:docker.process})).rejects.toThrow("non-root");expect(docker.calls).toEqual([]); } finally {uid.mockRestore();}
});

it("observes cancellation that arrives while preparing filesystem inputs", async () => {
 const f=await setup(),docker=dockerFixture(),controller=new AbortController();
 const pending=launchTrainingContainer({...f,image,timeoutMs:1000,signal:controller.signal,streams:streams(),process:docker.process});
 queueMicrotask(()=>controller.abort());
 expect(await pending).toBe(130);expect(docker.calls.every((args)=>args[2]!=="create")).toBe(true);
});
it("cleans a verified container even when create returned a truncated ID",async()=>{
 const f=await setup();let name="";
 const docker=dockerFixture(async(args)=>{
  if(args[2]==="create"){name=args[args.indexOf("--name")+1]!;return {code:0,stdout:id.slice(0,12),stderr:""};}
  if(args[2]==="inspect")return {code:0,stdout:[id,`/${name}`,image,{"com.spawnfile.training.owner":name}].map((v)=>JSON.stringify(v)).join("\n"),stderr:""};
  return undefined;
 });
 await expect(launchTrainingContainer({...f,image,timeoutMs:1000,streams:streams(),process:docker.process})).rejects.toThrow("valid training container identity");
 expect(docker.calls.some((args)=>args[2]==="rm"&&args.at(-1)===id)).toBe(true);
});

it("publishes the live cockpit only on host loopback and removes its container on cancellation",async()=>{
 const f=await setup(),controller=new AbortController();
 const docker=dockerFixture(async(args)=>{if(args[2]==="start"){controller.abort();throw Error("cancelled");}return undefined;});
 expect(await launchTrainingContainer({...f,args:[...f.args,"--view","53484"],image,timeoutMs:1000,signal:controller.signal,streams:streams(),process:docker.process})).toBe(130);
 const create=docker.calls.find((args)=>args[2]==="create")!;
 expect(create[create.indexOf("--publish")+1]).toBe("127.0.0.1:53484:53484");
 expect(create).not.toContain("0.0.0.0:53484:53484");expect(docker.calls.some((args)=>args[2]==="rm")).toBe(true);
});


it("stages private readonly context beside the shared output, never in host temporary storage", async () => {
  const f = await setup(); let scratch = "";
  const tmp = vi.spyOn(os, "tmpdir").mockImplementation(() => { throw Error("Host temp cannot be staged for Docker"); });
  const docker = dockerFixture(async (args) => {
    if (args[2] === "create") {
      const mount = args.find((entry) => entry.includes("dst=/run/paideia/context.json"))!;
      expect(mount.endsWith(",readonly")).toBe(true);
      const file = mount.split("src=")[1]!.split(",")[0]!; scratch = path.dirname(file);
      expect(path.dirname(scratch)).toBe(path.dirname(f.output));
      expect(scratch.startsWith(f.output + path.sep)).toBe(false);
      expect(f.config.inputs.some((entry) => scratch === entry.source || scratch.startsWith(entry.source + path.sep))).toBe(false);
      expect((await stat(scratch)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o444);
    }
    return undefined;
  });
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 1000, streams: streams(), process: docker.process })).toBe(0);
  expect(tmp).not.toHaveBeenCalled();
  await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains bounded useful Docker create errors while redacting declared auth paths", async () => {
  const f = await setup();
  const docker = dockerFixture(async (args) => args[2] === "create" ? { code: 1, stdout: "",
    stderr: `invalid mount config: bind source path does not exist: /shared/context.json\ncredential=${f.config.auth[0]!.source} ${"x".repeat(4000)}` }
    : args[2] === "inspect" ? { code: 1, stdout: "", stderr: "No container" } : undefined);
  const error = await launchTrainingContainer({ ...f, image, timeoutMs: 1000, streams: streams(), process: docker.process }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("bind source path does not exist: /shared/context.json");
  expect(message).toContain("[auth source]"); expect(message).not.toContain(f.config.auth[0]!.source);
  expect(message).not.toContain("\n"); expect(message.length).toBeLessThan(2200);
});
