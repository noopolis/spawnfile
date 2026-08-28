import { describe, expect, it } from "vitest";

import type { CompileReport } from "../report/index.js";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";
import { createDockerRunInvocation } from "./runProject.js";

const readiness:OrganizationReadinessEvidence={
  compileFingerprint:"sf1:000000000000",compileVersion:"0.1",hasExternalMoltnet:false,
  networks:[],organizationMembers:[],projectLabel:"generic",
  version:"spawnfile.organization-ready-evidence.v1",worldBindings:null
};

const report:CompileReport={
  compile_fingerprint:"sf1:test123",diagnostics:[],generated_at:"2026-08-26T00:00:00.000Z",
  nodes:[],output_directory:"/tmp/spawnfile-run-out",root:"/tmp/Spawnfile",spawnfile_version:"0.1",
  container:{dockerfile:"Dockerfile",entrypoint:"entrypoint.sh",env_example:".env.example",
    internal_ports:[],model_secrets_required:[],persistent_mounts:[{id:"state",mount_path:"/var/lib/spawnfile/state",reason:"state",volume_name:"spawnfile-state"}],
    port_mappings:[],ports:[],published_ports:[],runtime_homes:[],runtime_instances:[],
    runtime_secrets_required:[],runtimes_installed:[],secrets_required:[]}
};

describe("createDockerRunInvocation persistent volume mounts",()=>{
  it("uses volume-nocopy for compiler-declared volumes",async()=>{
    const invocation=await createDockerRunInvocation({organizationReadinessEvidence:readiness,outputDirectory:"/tmp/spawnfile-run-out",report,reportPath:"/tmp/spawnfile-run-out/spawnfile-report.json"},"spawnfile-test");
    expect(invocation.args).toContain("--mount");
    expect(invocation.args).toContain("type=volume,source=spawnfile-state,target=/var/lib/spawnfile/state,volume-nocopy");
    expect(invocation.args).not.toContain("spawnfile-state:/var/lib/spawnfile/state");
  });
});
