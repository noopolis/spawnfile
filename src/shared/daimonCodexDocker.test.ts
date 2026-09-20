import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  daimonEngineDockerSecurityArgsForConfigs,
  materializeDaimonGrokSeccompProfile,
  resolveDaimonEngineDockerInterop,
  DAIMON_GROK_SYSTEM_PATHS_SECURITY_OPT,
  DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS
} from "./daimonCodexDocker.js";
import { DAIMON_GROK_SECCOMP_PROFILE_BYTES, DAIMON_GROK_SECCOMP_PROFILE_SHA256 } from "./daimonGrokSeccompProfile.js";

const config = (...engines: Array<Record<string, unknown>>): string => JSON.stringify({
  agents: engines.map((engine, index) => ({ engine, id: `agent:${index}` })),
  version: "noopolis.daimon.organization-runtime.v1"
});
const strictCodex = { codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" }, kind: "codex" };
const grok = { kind: "grok", model: "grok-4.6", reasoningEffort: "low" };
const profilePath = "/tmp/spawnfile-security/seccomp.json";

describe("Daimon engine Docker security options", () => {
  it("runs Grok under the pinned default-plus-userns seccomp profile and AppArmor unconfined, never fully unconfined", async () => {
    expect(resolveDaimonEngineDockerInterop(config(grok))).toEqual({ codex: false, grok: true });
    const args = await daimonEngineDockerSecurityArgsForConfigs([config(grok, { kind: "codex" }, { kind: "agy" })], async () => profilePath);
    expect(args).toEqual([`--security-opt=seccomp=${profilePath}`, "--security-opt=apparmor=unconfined", DAIMON_GROK_SYSTEM_PATHS_SECURITY_OPT]);
    expect(args).not.toContain("--security-opt=seccomp=unconfined");
  });

  it("keeps Codex's fully unconfined options only when a strict Codex agent exists, and nothing for neither", async () => {
    let materialized = 0;
    const materialize = async () => { materialized += 1; return profilePath; };
    await expect(daimonEngineDockerSecurityArgsForConfigs([config(grok), config(strictCodex)], materialize))
      .resolves.toEqual(["--security-opt=seccomp=unconfined", "--security-opt=apparmor=unconfined"]);
    await expect(daimonEngineDockerSecurityArgsForConfigs([config({ kind: "codex" }, { kind: "agy" })], materialize)).resolves.toEqual([]);
    expect(materialized).toBe(0);
    await expect(daimonEngineDockerSecurityArgsForConfigs([config(grok)], async () => "relative.json")).rejects.toThrow(/absolute/u);
  });

  /**
   * The worker's bubblewrap sandbox mounts its own procfs, which the kernel refuses while Docker's
   * default `/proc` masking leaves the container's `/proc` partially hidden — Grok then refuses to
   * start at all rather than run unprotected. The flag is therefore load-bearing for every Grok turn,
   * and it is Grok-only: a Codex organization keeps Docker's masking untouched.
   */
  it("unmasks system paths for Grok only, and never for Codex", async () => {
    expect(DAIMON_GROK_SYSTEM_PATHS_SECURITY_OPT).toBe("--security-opt=systempaths=unconfined");
    const grokArgs = await daimonEngineDockerSecurityArgsForConfigs([config(grok)], async () => profilePath);
    expect(grokArgs).toEqual([
      `--security-opt=seccomp=${profilePath}`,
      "--security-opt=apparmor=unconfined",
      DAIMON_GROK_SYSTEM_PATHS_SECURITY_OPT
    ]);
    for (const codexOnly of [[config(strictCodex)], [config(strictCodex, grok)], [config({ kind: "codex" }, { kind: "agy" })]]) {
      const args = await daimonEngineDockerSecurityArgsForConfigs(codexOnly, async () => profilePath);
      expect(args, JSON.stringify(codexOnly)).not.toContain(DAIMON_GROK_SYSTEM_PATHS_SECURITY_OPT);
    }
    expect(DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS).not.toContain(DAIMON_GROK_SYSTEM_PATHS_SECURITY_OPT);
  });

  it("materializes the pinned seccomp profile byte-for-byte", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-grok-seccomp-"));
    try {
      const written = await materializeDaimonGrokSeccompProfile(path.join(directory, "security"));
      expect(path.isAbsolute(written)).toBe(true);
      const bytes = await readFile(written);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(DAIMON_GROK_SECCOMP_PROFILE_SHA256);
      expect(createHash("sha256").update(DAIMON_GROK_SECCOMP_PROFILE_BYTES).digest("hex")).toBe(DAIMON_GROK_SECCOMP_PROFILE_SHA256);
      const profile = JSON.parse(bytes.toString("utf8")) as { defaultAction: string; syscalls: Array<{ action: string; names: string[] }> };
      expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
      expect(profile.syscalls.some((rule) => rule.action === "SCMP_ACT_ALLOW"
        && ["clone", "clone3", "unshare", "mount", "umount2", "pivot_root", "setns"].every((name) => rule.names.includes(name)))).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
