import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Record<string, unknown[]> = {};
const record = (name: string) => (...args: unknown[]) => { calls[name] = args; };

vi.mock("../compiler/compileProject.js", () => ({
  compileProject: async (...args: unknown[]) => { record("compile")(...args); return { outputDirectory: "/out", report: { root: "/projects/acme/Spawnfile" } }; }
}));
vi.mock("../compiler/dockerBuildContext.js", () => ({ createDockerBuildContextDigest: async () => `sha256:${"e".repeat(64)}` }));
vi.mock("../compiler/dockerBuildSkip.js", () => ({ inspectDockerImage: async () => ({ id: "sha256:built", labels: {} }) }));
vi.mock("../compiler/buildProject.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../compiler/buildProject.js")>()),
  buildCompiledProject: async (...args: unknown[]) => { record("build")(...args); return { imageBuild: { buildMs: 42, skipped: false } }; },
  resolveDockerBuildArchitecture: async () => undefined
}));
vi.mock("../distribution/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../distribution/index.js")>()),
  consumeImageUp: async (...args: unknown[]) => { record("deploy")(...args); return { containerName: "spawnfile-org" }; },
  extractImageReport: async (...args: unknown[]) => { record("extract")(...args); return { report: { runtime_instances: [{ runtime: "daimon" }, { runtime: "pi" }] } }; }
}));

const { createDefaultReleaseDependencies } = await import("./releaseDefaults.js");

const request = {
  bundleIdentity: "release", deployment: "org", dockerCommand: "docker", drain: true, drainPollMs: 1, drainTimeoutMs: 1,
  envFileEnv: { A: "1" }, envFilePath: "/etc/org.env", force: false, inputPath: "/projects/acme", log: () => undefined,
  notifier: { kind: "none" }, notifyDeferredAfterMs: 1, settle: { pollMs: 1, polls: 1, stablePolls: 1 }
} as const;

beforeEach(() => { for (const key of Object.keys(calls)) delete calls[key]; });

describe("createDefaultReleaseDependencies", () => {
  it("compiles from committed inputs and takes the build-context digest as the identity", async () => {
    const compiled = await createDefaultReleaseDependencies().compile({ ...request });
    expect(compiled).toMatchObject({ identity: `sha256:${"e".repeat(64)}`, repository: "spawnfile-acme" });
    expect(calls.compile).toEqual(["/projects/acme", { bundleIdentity: "release" }]);
  });

  it("builds with the identity it already computed and the release tag", async () => {
    const deps = createDefaultReleaseDependencies();
    const compiled = await deps.compile({ ...request });
    const built = await deps.build({ ...request }, compiled, "spawnfile-acme:r-eeeeeeeeeeee");
    expect(built).toEqual({ buildMs: 42, imageId: "sha256:built", imageTag: "spawnfile-acme:r-eeeeeeeeeeee", skipped: false });
    expect(calls.build?.[2]).toMatchObject({ contextDigest: `sha256:${"e".repeat(64)}`, imageTag: "spawnfile-acme:r-eeeeeeeeeeee" });
  });

  it("deploys the tag into the named deployment with the operator's env file", async () => {
    const deployed = await createDefaultReleaseDependencies().deploy({ ...request }, "spawnfile-acme:r-eeeeeeeeeeee");
    expect(deployed.containerName).toBe("spawnfile-org");
    expect(calls.deploy).toEqual(["spawnfile-acme:r-eeeeeeeeeeee", expect.objectContaining({ deploymentLockHeld: true, deploymentName: "org", envFileEnv: { A: "1" }, envFilePath: "/etc/org.env" })]);
  });

  it("reads the running image's runtime kinds from its embedded report", async () => {
    expect(await createDefaultReleaseDependencies().runtimesOf({ ...request, dockerContext: "prod" }, "sha256:img")).toEqual(["daimon", "pi"]);
    expect(calls.extract).toEqual(["sha256:img", { dockerCommand: "docker", dockerContext: "prod" }]);
  });

  it("reads the env file inside the release", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "spawnfile-env-")), "deploy.env");
    await writeFile(file, "SPAWNFILE_DAIMON_CONTROL_TOKEN=abc\n");
    expect(await createDefaultReleaseDependencies().prepare({ ...request, envFilePath: file })).toEqual({ authProfile: null, envFileEnv: { SPAWNFILE_DAIMON_CONTROL_TOKEN: "abc" } });
    await expect(createDefaultReleaseDependencies().prepare({ ...request, envFilePath: "/nonexistent/deploy.env" })).rejects.toThrow();
  });

  it("honours an explicit image repository", async () => {
    expect((await createDefaultReleaseDependencies().compile({ ...request, imageRepository: "registry.local/acme" })).repository).toBe("registry.local/acme");
  });
});
