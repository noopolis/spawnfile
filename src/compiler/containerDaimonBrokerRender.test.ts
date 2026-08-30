import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";
import {
  renderDaimonBrokerProvisioning,
  renderDaimonWorkspaceResourceSecurity
} from "./containerDaimonBrokerRender.js";

const execFile = promisify(execFileCallback);
const uid = process.getuid?.() ?? 501;
const gid = process.getgid?.() ?? 20;
const owners = { linkUid: uid, linkGid: gid, readonlyUid: uid, readonlyGid: gid, privilegedUid: uid, privilegedGid: gid };

describe("Daimon broker registration ABI", () => {
  it("renders the manifest-declared native ABI version", () => {
    const plan = {
      runtimeName: "daimon",
      engineByNodeId: { "agent:grok": "grok" },
      instancePaths: { workspacePath: "/workspace" }
    } as unknown as Parameters<typeof renderDaimonBrokerProvisioning>[0][number];
    expect(renderDaimonBrokerProvisioning([plan]).join("\n"))
      .toContain("record.writeUInt32LE(2, 0)");
  });
});

describe("Daimon broker usage ledger provisioning", () => {
  const plan = {
    runtimeName: "daimon",
    engineByNodeId: { "agent:grok": "grok" },
    instancePaths: { workspacePath: "/workspace" }
  } as unknown as Parameters<typeof renderDaimonBrokerProvisioning>[0][number];

  it("provisions the usage ledger directory alongside the realm", () => {
    const program = renderDaimonBrokerProvisioning([plan]).join("\n");
    const { directoryPath } = DAIMON_GROK_TURN_USAGE_LEDGER;
    expect(program).toContain(
      `fs.mkdirSync('${directoryPath}', { recursive: true, mode: 0o750 }); fs.chownSync('${directoryPath}', 2100, 2100); fs.chmodSync('${directoryPath}', 0o750);`
    );
  });

  it("denies worker access to the usage ledger directory", () => {
    const program = renderDaimonBrokerProvisioning([plan]).join("\n");
    const deniedForLine = program.split("\n").find((line) => line.includes("const deniedFor ="));
    expect(deniedForLine).toBeDefined();
    expect(deniedForLine).toContain(
      `'/var/lib/spawnfile/instances/daimon/daimon-organization/state', '${DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath}']);`
    );
  });
});

const validate = async (root: string, resource: Parameters<typeof renderDaimonWorkspaceResourceSecurity>[0][number], linkPath: string, expectedOwners = owners, infoOverride: Record<string, number> = {}, pathOverrides:Record<string,Record<string,number>>={},secondFstatOverride:Record<string,number>={}) => {
  const program = [
    "const fs=require('node:fs');",
    "const originalLstat=fs.lstatSync.bind(fs),overrides=JSON.parse(process.argv[3]);fs.lstatSync=(target)=>Object.assign(originalLstat(target),overrides[target]??{});",
    "const originalOpen=fs.openSync.bind(fs),fdPaths=new Map();fs.openSync=(target,...args)=>{const fd=originalOpen(target,...args);fdPaths.set(fd,target);return fd;};const originalFstat=fs.fstatSync.bind(fs),second=JSON.parse(process.argv[4]);let fstatCalls=0;fs.fstatSync=(fd)=>Object.assign(originalFstat(fd),overrides[fdPaths.get(fd)]??{},++fstatCalls===2?second:{});",
    ...renderDaimonWorkspaceResourceSecurity([resource], expectedOwners, `${root}/`),
    "const info=fs.lstatSync(process.argv[1]);Object.assign(info,JSON.parse(process.argv[2]));validateResourceLink(process.argv[1],info);"
  ].join("\n");
  return execFile(process.execPath, ["-e", program, linkPath, JSON.stringify(infoOverride),JSON.stringify(pathOverrides),JSON.stringify(secondFstatOverride)]);
};

describe("Daimon worker workspace resource link guard", () => {
  it("accepts only the exact compiler declaration and remains restart-idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-resource-guard-"));
    try {
      const backing = path.join(root, "readonly"), linkPath = path.join(root, "workspace-link");
      await mkdir(backing); await chmod(backing, 0o555); await symlink(backing, linkPath);
      const resource = { backingPath: backing, kind: "git" as const, linkPath, mode: "readonly" as const, resolvedIdentity: null };
      await expect(validate(root, resource, linkPath)).resolves.toBeDefined();
      await expect(validate(root, resource, linkPath)).resolves.toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects undeclared, substituted, relative, outside, linked, and unsafe backing identities", async () => {
    const cases = ["undeclared", "substituted", "relative", "outside", "traversal", "linked", "owner", "mode", "type"] as const;
    for (const fault of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), `spawnfile-resource-${fault}-`));
      try {
        const backing = path.join(root, "backing"), other = path.join(root, "other"), linkPath = path.join(root, "link");
        if (fault === "type") await writeFile(backing, "file"); else { await mkdir(backing); await chmod(backing, fault === "mode" ? 0o755 : 0o555); }
        await mkdir(other); await chmod(other, 0o555);
        const traversal=`${root}/../../etc`;await symlink(fault === "relative" ? "backing" : fault === "substituted" ? other : fault === "outside" ? os.tmpdir() : fault==="traversal"?traversal:backing, linkPath);
        const resource = { backingPath: fault==="traversal"?traversal:backing, kind: "git" as const, linkPath: fault === "undeclared" ? `${linkPath}-other` : linkPath, mode: "readonly" as const, resolvedIdentity: null };
        await expect(validate(root, resource, linkPath, fault === "owner" ? { ...owners, linkUid: uid + 1 } : owners, fault === "linked" ? { nlink: 2 } : {})).rejects.toThrow();
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  it("rejects missing, wrong, and symbolic volume identity sentinels", async () => {
    for (const fault of ["missing", "wrong", "link","fifo"] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `spawnfile-volume-${fault}-`));
      try {
        const backing = path.join(root, "volume"), linkPath = path.join(root, "link"), sentinel = path.join(backing, ".spawnfile-resource-identity");
        await mkdir(backing); await chmod(backing, 0o755); await symlink(backing, linkPath);
        if (fault === "wrong") await writeFile(sentinel, "wrong\n", { mode: 0o644 });
        if (fault === "link") await symlink(path.join(root, "missing"), sentinel);
        if(fault==="fifo")await execFile("mkfifo",[sentinel]);
        const resource = { backingPath: backing, kind: "volume" as const, linkPath, mode: "mutable" as const, resolvedIdentity: `sha256:${"a".repeat(64)}` };
        await expect(validate(root, resource, linkPath)).rejects.toThrow();
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  it("accepts only declared volume preboot and post-materialization owners with the privileged identity sentinel",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"spawnfile-volume-lifecycle-"));
    try{
      const expectedOwners={linkUid:2000,linkGid:2000,readonlyUid:2000,readonlyGid:2000,privilegedUid:0,privilegedGid:0};const link={uid:2000,gid:2000,nlink:1};
      const resolvedIdentity=`sha256:${"a".repeat(64)}`;
      for(const name of ["agent-a-data","agent-b-data","agent-c-data","agent-d-staging","agent-e-data","team-state"]){const backing=path.join(root,name),linkPath=path.join(root,`${name}-link`),sentinel=path.join(backing,".spawnfile-resource-identity");await mkdir(backing);await chmod(backing,0o755);await writeFile(sentinel,`${resolvedIdentity}\n`,{mode:0o644});await symlink(backing,linkPath);const resource={backingPath:backing,kind:"volume" as const,linkPath,mode:"mutable" as const,resolvedIdentity};const identity={[sentinel]:{uid:0,gid:0,nlink:1,mode:0o100644}};await expect(validate(root,resource,linkPath,expectedOwners,link,{...identity,[backing]:{uid:0,gid:0,mode:0o40755}})).resolves.toBeDefined();await expect(validate(root,resource,linkPath,expectedOwners,link,{...identity,[backing]:{uid:2000,gid:2000,mode:0o40755}})).resolves.toBeDefined();}
      const backing=path.join(root,"agent-a-data"),linkPath=path.join(root,"agent-a-data-link"),sentinel=path.join(backing,".spawnfile-resource-identity"),resource={backingPath:backing,kind:"volume" as const,linkPath,mode:"mutable" as const,resolvedIdentity},identity={[sentinel]:{uid:0,gid:0,nlink:1,mode:0o100644}};
      for(const backingIdentity of [{uid:2001,gid:2000,mode:0o40755},{uid:2000,gid:0,mode:0o40755},{uid:2000,gid:2000,mode:0o40750}])await expect(validate(root,resource,linkPath,expectedOwners,link,{...identity,[backing]:backingIdentity})).rejects.toThrow();
      await expect(validate(root,resource,linkPath,expectedOwners,link,{[sentinel]:{uid:2000,gid:2000,nlink:1,mode:0o100644},[backing]:{uid:2000,gid:2000,mode:0o40755}})).rejects.toThrow();
      const changedStats:Record<string,number>[]=[{ino:999999},{size:0},{mtimeMs:0},{ctimeMs:0}];
      for(const changed of changedStats)await expect(validate(root,resource,linkPath,expectedOwners,link,{...identity,[backing]:{uid:2000,gid:2000,mode:0o40755}},changed)).rejects.toThrow();
      for(const suffix of [" ","\n","extra"]){await writeFile(sentinel,`${resolvedIdentity}\n${suffix}`,{mode:0o644});await expect(validate(root,resource,linkPath,expectedOwners,link,{...identity,[backing]:{uid:2000,gid:2000,mode:0o40755}})).rejects.toThrow();}
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
