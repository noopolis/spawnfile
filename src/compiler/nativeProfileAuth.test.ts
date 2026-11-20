import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerNativeLogin } from "../auth/index.js";
import { prepareImageRuntimeAuthMounts } from "../distribution/imageRuntimeAuth.js";
import type { DistributionReport } from "../distribution/types.js";
import { compileProject } from "./compileProject.js";
import { initProject } from "./initProject.js";
import { prepareRuntimeAuthMounts, resolveHostCliCredential } from "./runProjectAuth.js";
import { syncProjectAuth } from "./syncProjectAuth.js";

describe("native subscription selection through source and installed image", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "sf-native-profile-"));
    vi.stubEnv("CODEX_HOME", path.join(directory, "unused-desktop"));
    vi.stubEnv("SPAWNFILE_HOME", path.join(directory, "operator"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it.each(["hermes-agent", "opencode"])("uses only the selected %s account in every launch path", async runtime => {
    const project = path.join(directory, "project");
    await initProject({ directory: project, runtime });
    const compiled = await compileProject(project, { outputDirectory: path.join(directory, "out") });
    const container = compiled.report.container!;
    const instance = container.runtime_instances[0]!;
    const output = compiled.outputDirectory;
    const dist = JSON.parse(await readFile(path.join(output, "distribution-report.json"), "utf8")) as DistributionReport;
    expect(instance.model_auth_methods).toEqual({ openai: "codex" });
    expect(container.secrets_required).not.toContain("SPAWNFILE_CLI_AUTH_JSON");
    expect(await readFile(path.join(output, ".env.example"), "utf8")).not.toContain("OPENAI_API_KEY");
    expect(await resolveHostCliCredential(container)).toBeNull();
    await expect(syncProjectAuth(project, { profileName: "ops" })).resolves.toMatchObject({ imports: {} });
    const prepareImage = (authProfile: Parameters<typeof prepareImageRuntimeAuthMounts>[0]["authProfile"]) =>
      prepareImageRuntimeAuthMounts({ authProfile, tempRoot: directory, report: dist, sourceEnvironment: {} });
    await expect(prepareImage(null)).rejects.toThrow(/profile/i);
    const profile = await registerNativeLogin("ops", `${runtime}/openai/${instance.id}`, "synthetic-grant");
    const source = await prepareRuntimeAuthMounts(output, container, profile, {}, directory);
    expect(source.mountArgs).toEqual(["--mount", expect.stringMatching(/^type=volume,source=synthetic-grant,target=\/var\/lib\/spawnfile\//u)]);
    expect((await prepareImage(profile)).mountArgs).toEqual(source.mountArgs);
    const wrong = { ...profile, nativeLogins: { [`${runtime}/openai/someone-else`]: "foreign-grant" } };
    await expect(prepareImage(wrong)).rejects.toThrow();
  });
});
