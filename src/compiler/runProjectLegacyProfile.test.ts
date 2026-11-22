import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, expect, it, vi } from "vitest";
import { registerImportedAuth, registerNativeLogin, requireAuthProfile } from "../auth/index.js";
import { consumeImageUp } from "../distribution/consumeImage.js";
import { DISTRIBUTION_REPORT_IMAGE_PATH, type DistributionReport } from "../distribution/types.js";
import * as filesystem from "../filesystem/index.js";
import { compileProject } from "./compileProject.js";
import { escapeMountInfoPath } from "./containerBackedMountRender.js";
import { CLI_CREDENTIAL_SECRET_NAME } from "./modelEnv.js";
import { createDockerRunInvocation, runProject, type DockerRunInvocation } from "./runProject.js";
import { upProject } from "./upProject.js";

const roots: string[] = [];
const containerId = "a".repeat(64);
const imageId = "sha256:" + "b".repeat(64);
const nativeRuntimes = ["hermes-agent", "opencode"] as const;
const accountBytes = (account: string) =>
  `{ "tokens": { "access_token": "${account}-access", "refresh_token": "${account}-refresh", "account_id": "${account}" } }\n`;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const tarFile = (bytes: Buffer): Buffer => {
  const tar = Buffer.alloc(512 + Math.ceil(bytes.length / 512) * 512 + 1024);
  tar.write("distribution-report.json");
  tar.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  tar.write("0", 156);
  bytes.copy(tar, 512);
  return tar;
};

const fixture = async (legacy: string | null, legacyMethod: "codex" | "claude-code" = "codex") => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-legacy-profile-"));
  roots.push(root);
  vi.stubEnv("SPAWNFILE_HOME", path.join(root, "operator"));
  vi.stubEnv("NOOPOLIS_RUN_ID", undefined);
  vi.stubEnv(CLI_CREDENTIAL_SECRET_NAME, undefined);
  const desktop = path.join(root, "desktop");
  vi.stubEnv("CODEX_HOME", desktop);
  await mkdir(desktop, { mode: 0o700 });
  const desktopAuth = path.join(desktop, "auth.json");
  await writeFile(desktopAuth, accountBytes("desktop-account"), { mode: 0o600 });

  const runtimes = legacy ? [...nativeRuntimes, legacy] : [...nativeRuntimes];
  const claudeLegacy = legacyMethod === "claude-code";
  await writeFile(path.join(root, "AGENTS.md"), "Synthetic profile routing fixture.\n");
  await writeFile(path.join(root, "Spawnfile"), `
spawnfile_version: "0.1"
kind: team
name: profile-routing
mode: swarm
members:
${runtimes.map(runtime => `  - id: ${runtime}
    runtime: ${runtime}
    execution:
      model:
        primary:
          provider: ${runtime === legacy && claudeLegacy ? "anthropic" : "openai"}
          name: ${runtime === legacy && claudeLegacy ? "claude-sonnet-4" : "gpt-5"}
          auth: { method: ${runtime === legacy ? legacyMethod : "codex"} }
    workspace:
      docs: { system: AGENTS.md }`).join("\n")}
`);
  const outputDirectory = path.join(root, "out");
  const compiled = await compileProject(root, { outputDirectory });
  const instances = compiled.report.container!.runtime_instances;
  const imported = await registerImportedAuth("fixture", legacyMethod);
  const selectedAuth = path.join(imported.directory, claudeLegacy ? ".credentials.json" : "auth.json");
  const selectedBytes = claudeLegacy
    ? '{ "claudeAiOauth": { "accessToken": "selected-legacy-access", "refreshToken": "selected-legacy-refresh", "expiresAt": 4102444800000 } }\n'
    : accountBytes("selected-legacy");
  const privateData = path.join(imported.directory, "private-data");
  await writeFile(selectedAuth, selectedBytes, { mode: 0o600 });
  await writeFile(privateData, "private legacy data\n", { mode: 0o600 });

  const nativeAccounts: Array<{ runtime: string; volumeName: string; bytes: string; nativeData: string }> = [];
  for (const runtime of nativeRuntimes) {
    const { id } = instances.find(instance => instance.runtime === runtime)!;
    const volumeName = `synthetic-${runtime}-account`;
    await registerNativeLogin("fixture", `${runtime}/openai/${id}`, volumeName);
    const bytes = accountBytes(volumeName);
    const nativeData = path.join(root, volumeName);
    await writeFile(nativeData, bytes, { mode: 0o600 });
    nativeAccounts.push({ runtime, volumeName, bytes, nativeData });
  }
  const checkPrivateData = async () => {
    expect(await readFile(selectedAuth, "utf8")).toBe(selectedBytes);
    expect((await lstat(selectedAuth)).mode & 0o777).toBe(0o600);
    expect(await readFile(privateData, "utf8")).toBe("private legacy data\n");
    expect(await readFile(desktopAuth, "utf8")).toBe(accountBytes("desktop-account"));
    for (const { bytes, nativeData } of nativeAccounts) expect(await readFile(nativeData, "utf8")).toBe(bytes);
  };
  const reads = vi.spyOn(filesystem, "readUtf8File");
  const stats = vi.spyOn(filesystem, "fileExists");
  const checkInvocation = async (args: string[], envFilePath: string) => {
    const env = await readFile(envFilePath, "utf8");
    expect(env).not.toMatch(/SPAWNFILE_CLI_AUTH_JSON|desktop-account|selected-legacy|synthetic-.*-account/u);
    expect(reads.mock.calls.some(([file]) => file === desktopAuth)).toBe(false);
    expect(stats.mock.calls.some(([file]) => file === desktopAuth)).toBe(false);
    for (const { runtime, volumeName } of nativeAccounts) {
      expect(args).toContainEqual(expect.stringMatching(new RegExp(`source=${volumeName},target=/var/lib/spawnfile/instances/${runtime}/`, "u")));
    }
    const legacyHome = instances.find(instance => instance.runtime === legacy)?.home_path;
    const rawMounts = args.filter(arg => arg.startsWith(`${imported.directory}:`));
    expect(rawMounts).toEqual(legacyHome ? [`${imported.directory}:${legacyHome}/${claudeLegacy ? ".claude" : ".codex"}`] : []);
    if (legacy === "openclaw") {
      const credentialMount = args.find(arg => arg.endsWith(`:${legacyHome}/.openclaw/agents/main/agent/auth-profiles.json`))!;
      const projected = await readFile(credentialMount.split(":")[0]!, "utf8");
      expect(projected).toContain("selected-legacy-access");
      expect(projected).not.toContain("desktop-account");
    }
  };
  return { checkInvocation, checkPrivateData, compiled, imported, instances, outputDirectory, root, selectedAuth };
};

it.each([
  ["openclaw", "codex"],
  ["picoclaw", "codex"],
  ["openclaw", "claude-code"],
  ["picoclaw", "claude-code"],
  [null, "codex"]
] as const)("keeps selected accounts private through foreground, detached and image launch (%s, %s)", async (legacy, method) => {
  const { checkInvocation, checkPrivateData, outputDirectory, root } = await fixture(legacy, method);
  const options = { authProfile: "fixture", containerArchitecture: "amd64" as const, outputDirectory };
  const checkRun = async (invocation: DockerRunInvocation) => await checkInvocation(invocation.args, invocation.envFilePath);
  await runProject(root, { ...options, runRunner: checkRun });
  await checkPrivateData();
  let detachedEnv: string | undefined;
  const detached = await upProject(root, {
    ...options,
    buildRunner: async () => undefined,
    deploymentName: "fixture-detached",
    detach: true,
    dockerHost: "unix:///tmp/spawnfile-private-fixture.sock",
    runRunner: async invocation => {
      roots.push(invocation.supportDirectory);
      detachedEnv = invocation.envFilePath;
      expect(invocation.detach).toBe(true);
      await checkRun(invocation);
      return { containerId, containerName: invocation.containerName!, imageId, deploymentLabels: invocation.deploymentLabels };
    }
  });
  expect(detached.deploymentRecordPath).toBeTruthy();
  await expect(readFile(detachedEnv!)).rejects.toMatchObject({ code: "ENOENT" });
  await checkPrivateData();

  const reportBytes = await readFile(path.join(outputDirectory, "distribution-report.json"));
  const report = JSON.parse(reportBytes.toString()) as DistributionReport;
  const reservations = new Map<string, Record<string, string>>();
  let started = false;
  const image = await consumeImageUp("private/fixture:local", {
    authProfile: await requireAuthProfile("fixture"),
    deploymentName: "fixture-image",
    dockerHost: "unix:///tmp/spawnfile-private-fixture.sock",
    runDocker: async args => {
      if (args[0] === "image" && args.includes("{{json .Config.Labels}}")) {
        return Buffer.from(JSON.stringify({
          "com.spawnfile.image_contract": "spawnfile.image.v1",
          "com.spawnfile.compile_fingerprint": report.compile_fingerprint,
          "com.spawnfile.report": DISTRIBUTION_REPORT_IMAGE_PATH,
          "com.spawnfile.project": report.organization.project
        }));
      }
      if (args[0] === "cp") return tarFile(reportBytes);
      if (args[0] === "ps" && args.includes("--filter")) return Buffer.alloc(0);
      if (args[0] === "container" && args[1] === "create") {
        const name = args[args.indexOf("--name") + 1]!;
        const id = createHash("sha256").update(name).digest("hex");
        expect(reservations.has(id)).toBe(false);
        const labels = args.flatMap((arg, index) => arg === "--label" ? [args[index + 1]!.split("=")] : []);
        reservations.set(id, Object.fromEntries(labels));
        return Buffer.from(id);
      }
      const reference = args.at(-1)!;
      if (args[0] === "container" && reservations.has(reference)) {
        if (args[1] === "inspect") return Buffer.from([JSON.stringify(reference), JSON.stringify(reservations.get(reference))].join("\n"));
        if (args[1] === "rm") {
          reservations.delete(reference);
          return Buffer.from(reference);
        }
      }
      if (args[0] === "run") {
        await checkInvocation(args, args[args.indexOf("--env-file") + 1]!);
        started = true;
        return Buffer.from(containerId);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        if (!started) throw new Error("No such container");
        return Buffer.from([JSON.stringify(containerId), '"/spawnfile-fixture-image"', '{"Running":true,"Status":"running"}'].join("\n"));
      }
      if (args[0] === "image" && args.includes("{{.Id}}")) return Buffer.from(imageId);
      if (args[0] === "image" && args.includes("{{json .RepoDigests}}")) return Buffer.from("[]");
      if (["create", "rm"].includes(args[0]!)) return Buffer.alloc(0);
      throw new Error(`Unexpected fake Docker command: ${args[0]} ${args[1] ?? ""}`);
    }
  });
  expect(image.record.units[0]?.container_id).toBe(containerId);
  expect(reservations.size).toBe(0);
  await checkPrivateData();
});

it.each(["codex", "claude-code"] as const)("runs the %s credential shell with and without an explicit env value", async method => {
  const { checkPrivateData, compiled, imported, instances, outputDirectory, root } = await fixture("picoclaw", method);
  const home = instances.find(({ runtime }) => runtime === "picoclaw")!.home_path!;
  const localHome = path.join(root, "fake-runtime-home");
  await mkdir(localHome, { mode: 0o700 });
  const mount = path.join(localHome, method === "codex" ? ".codex" : ".claude");
  await symlink(imported.directory, mount, "dir");
  const mountinfo = path.join(root, "mountinfo");
  const persistentMounts = compiled.report.container!.persistent_mounts ?? [];
  const mountPoints = [mount, ...persistentMounts.map(binding => binding.mount_path)];
  await writeFile(mountinfo, mountPoints.map((target, index) =>
    `${100 + index} 99 0:1 / ${escapeMountInfoPath(target)} rw - ext4 /dev/example rw\n`).join(""));
  const script = await readFile(path.join(outputDirectory, "entrypoint.sh"), "utf8");
  const unset = `unset ${CLI_CREDENTIAL_SECRET_NAME}\n`;
  expect(script).toContain(unset);
  const credentialShell = (script.slice(0, script.indexOf(unset) + unset.length) +
    `test -z "\${${CLI_CREDENTIAL_SECRET_NAME}:-}"\n`)
    .replaceAll("/proc/self/mountinfo", mountinfo).replaceAll(home, localHome);
  for (const value of [accountBytes("explicit-other"), ""]) {
    const result = spawnSync("bash", ["-c", credentialShell], { env: { PATH: process.env.PATH, [CLI_CREDENTIAL_SECRET_NAME]: value } });
    expect(result.stderr.toString()).toBe("");
    expect(result.status).toBe(0);
    if (method === "claude-code") {
      await expect(lstat(path.join(localHome, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await checkPrivateData();
  }
});

it("fails on an unusable selected import even if a different explicit credential exists", async () => {
  const { compiled, selectedAuth } = await fixture("picoclaw");
  await writeFile(selectedAuth, "{}\n");
  await expect(createDockerRunInvocation(compiled, "fixture:local", {
    authProfile: await requireAuthProfile("fixture"),
    cliCredential: { name: CLI_CREDENTIAL_SECRET_NAME, value: accountBytes("explicit-other").trim() }
  })).rejects.toThrow(/Imported codex auth .* has no usable credential/u);
});

it("forwards explicit env auth for a legacy peer with no selected import", async () => {
  const { compiled, imported } = await fixture("picoclaw");
  const profile = await requireAuthProfile("fixture");
  const value = accountBytes("explicit-other").trim();
  const invocation = await createDockerRunInvocation(compiled, "fixture:local", {
    authProfile: { ...profile, imports: {} },
    cliCredential: { name: CLI_CREDENTIAL_SECRET_NAME, value }
  });
  roots.push(invocation.supportDirectory);
  expect(invocation.args.some(arg => arg.startsWith(`${imported.directory}:`))).toBe(false);
  expect(await readFile(invocation.envFilePath, "utf8")).toContain(`${CLI_CREDENTIAL_SECRET_NAME}=${value}\n`);
});
