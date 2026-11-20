import { afterEach, expect, it, vi } from "vitest";

import type { ResolvedAuthProfile } from "../auth/index.js";
import { removeDirectory } from "../filesystem/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import * as registry from "../runtime/registry.js";
import type { CompileProjectResult } from "./compileProject.js";
import { createDockerRunInvocation } from "./runProject.js";
import type { DockerRunInvocation } from "./runProjectDocker.js";

const builtIn: ContainerRuntimeInstanceReport = {
  runtime: "openclaw", id: "agent-test", config_path: "/state/config.json",
  home_path: "/state/home", model_auth_methods: {}, model_secrets_required: []
};

const compiled = (instances: ContainerRuntimeInstanceReport[]): CompileProjectResult => ({
  organizationReadinessEvidence: {
    compileFingerprint: "sf1:000000000000", compileVersion: "0.1", hasExternalMoltnet: false,
    networks: [], organizationMembers: [], projectLabel: "fixture",
    version: "spawnfile.organization-ready-evidence.v1", worldBindings: null
  },
  outputDirectory: "/unused",
  report: {
    diagnostics: [], nodes: [], root: "/unused", spawnfile_version: "0.1",
    container: {
      dockerfile: "Dockerfile", entrypoint: "entrypoint.sh", env_example: ".env.example",
      model_secrets_required: [], ports: [], runtime_instances: instances,
      runtime_homes: [], runtime_secrets_required: [], runtimes_installed: [], secrets_required: []
    }
  },
  reportPath: "/unused/spawnfile-report.json"
});

afterEach(() => vi.restoreAllMocks());

it("keeps the host receiver when passing the project Docker credential guard to the runner", async () => {
  class Host {
    #endpoint = "unix:///fixture/daemon.sock";

    async prepareCredentialDocker(invocation: DockerRunInvocation) {
      return { ...invocation, dockerHost: this.#endpoint };
    }
  }
  const selected = registry.getRuntimeAdapter("openclaw");
  const registered = registry.getRuntimeAdapter;
  vi.spyOn(registry, "getRuntimeAdapter").mockImplementation((name) => name === "openclaw" ? {
    ...selected,
    host: new Host(),
    async prepareRuntimeAuth() {
      return { launchIdentity: { kind: "sample", uid: 1234 }, coveredModelSecrets: [], mountArgs: [] };
    }
  } : registered(name));

  const invocation = await createDockerRunInvocation(compiled([builtIn]), "fixture:local");
  try {
    expect(invocation.prepareCredentialDocker).toBeDefined();
    await expect(invocation.prepareCredentialDocker!(invocation))
      .resolves.toMatchObject({ dockerHost: "unix:///fixture/daemon.sock" });
  } finally {
    await removeDirectory(invocation.supportDirectory);
  }
});

it("refuses to stage a raw import across a shared project container", async () => {
  const recipient = { ...builtIn, model_auth_methods: { openai: "codex" as const } };
  const unrelated = { ...builtIn, runtime: "external-harness", id: "agent-unrelated", home_path: "/state/guest" };
  const authProfile: ResolvedAuthProfile = {
    name: "fixture", authHome: "/auth", profileDirectory: "/auth/fixture", profilePath: "/auth/fixture/profile.json",
    version: 1, env: {}, imports: { codex: { kind: "codex", path: "/auth/fixture/codex" } }
  };
  await expect(createDockerRunInvocation(compiled([recipient, unrelated]), "fixture:local", { authProfile }))
    .rejects.toThrow(/external-harness does not request or support the codex import/u);
});
