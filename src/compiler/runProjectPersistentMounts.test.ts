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
  // The image is the authority for the bootstrap preimage at every
  // compiler-declared persistent mount path (`createStateOwnershipCommand`
  // writes `.spawnfile-volume-init` there at build time), and both the Daimon
  // ownership guard and `prepare_volume_resource` require that marker to
  // accept a fresh volume. `volume-nocopy` suppresses exactly the copy-up that
  // delivers it, so no Daimon organization with persistent volumes could
  // bootstrap. This test previously asserted the defect.
  it("mounts compiler-declared volumes with copy-up so the image can seed them",async()=>{
    const invocation=await createDockerRunInvocation({organizationReadinessEvidence:readiness,outputDirectory:"/tmp/spawnfile-run-out",report,reportPath:"/tmp/spawnfile-run-out/spawnfile-report.json"},"spawnfile-test");
    expect(invocation.args).toContain("--mount");
    expect(invocation.args).toContain("type=volume,source=spawnfile-state,target=/var/lib/spawnfile/state");
    expect(invocation.args.join("\n")).not.toContain("volume-nocopy");
    expect(invocation.args).not.toContain("spawnfile-state:/var/lib/spawnfile/state");
  });

  it("boots against an external gateway: joins the given network and mounts no gatewayed realm",async()=>{
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const os = await import("node:os"), path = await import("node:path");
    const envFilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "spawnfile-gw-env-")), "run.env");
    await writeFile(envFilePath, "DAIMON_GATEWAY_URL=http://gateway:43200\nDAIMON_GATEWAY_KEY=" + "k".repeat(32) + "\n", { mode: 0o600 });
    const realm = { id: "daimon-codex-subscription-realm", lifecycle: "exclusive-reattach" as const, mount_path: "/var/lib/spawnfile/daimon/codex-subscription-realm", reason: "realm", volume_name: "spawnfile-realm" };
    const withRealm = { ...report, container: { ...report.container!, persistent_mounts: [...report.container!.persistent_mounts!, realm] } };
    const compiled = { organizationReadinessEvidence: readiness, outputDirectory: "/tmp/spawnfile-run-out", report: withRealm, reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json" };
    const external = await createDockerRunInvocation(compiled, "spawnfile-test", { envFilePath, network: "training-gw" });
    expect(external.args.slice(external.args.indexOf("--network"), external.args.indexOf("--network") + 2)).toEqual(["--network", "training-gw"]);
    expect(external.args.join("\n")).not.toContain("spawnfile-realm");
    expect(external.args).toContain("type=volume,source=spawnfile-state,target=/var/lib/spawnfile/state");
    expect(external.exclusiveReattachVolumes).toBeUndefined();
    const local = await createDockerRunInvocation(compiled, "spawnfile-test");
    expect(local.args).toContain("type=volume,source=spawnfile-realm,target=/var/lib/spawnfile/daimon/codex-subscription-realm");
    expect(local.args).not.toContain("--network");
  });
});
