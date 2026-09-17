#!/usr/bin/env node
// Explicit opt-in live check for a one-agent brokered Grok 1.0.34 organization:
// deploy fixtures/grok-lean-worker against a locally built Daimon runtime image,
// dump the worker home/sandbox/service attestation inputs, run one cheap wake,
// and require exactly one deduplicated usage row written by the broker.
// Needs Docker, a built CLI (`npm run build`), a local Daimon runtime identity
// built from the Daimon Grok accounting contract, and a dedicated Grok login
// file (never the desktop ~/.grok/auth.json). Makes one real model call.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = "grok-lean-live";
const workerHome = "/var/lib/daimon-workers/2200";
const usageLedger = "/var/lib/spawnfile/daimon/usage/usage.jsonl";

export const requireLiveCheckEnvironment = (env: Record<string, string | undefined>): { grokAuth: string; identity: string } => {
  if (env.SPAWNFILE_GROK_LIVE_CHECK !== "1") throw new Error("Set SPAWNFILE_GROK_LIVE_CHECK=1 to run the live Grok lean-worker check (one real model call)");
  const identity = env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY?.trim();
  const grokAuth = env.SPAWNFILE_DAIMON_SOURCE_GROK_AUTH?.trim();
  if (!identity || !path.isAbsolute(identity)) throw new Error("SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY must name the local Daimon runtime identity file");
  if (!grokAuth || !path.isAbsolute(grokAuth)) throw new Error("SPAWNFILE_DAIMON_SOURCE_GROK_AUTH must name a dedicated 0600 Grok login file");
  if (path.resolve(grokAuth) === path.join(os.homedir(), ".grok", "auth.json")) throw new Error("Refusing the desktop ~/.grok/auth.json; use a dedicated Grok login");
  return { grokAuth, identity };
};

const run = (command: string, args: string[], input?: string): string =>
  execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] });

const containerFor = (): string => {
  const ids = run("docker", ["ps", "--filter", `label=com.spawnfile.deployment=${deployment}`, "--format", "{{.ID}}"]).trim().split("\n").filter(Boolean);
  if (ids.length !== 1) throw new Error(`expected one running container for ${deployment}, found ${ids.length}`);
  return ids[0]!;
};

const exec = (container: string, script: string): string => run("docker", ["exec", container, "bash", "-ceu", script]);

const main = (): void => {
  requireLiveCheckEnvironment(process.env);
  const out = mkdtempSync(path.join(os.tmpdir(), "spawnfile-grok-lean-live-"));
  try {
    run(process.execPath, ["dist/cli/index.js", "up", "fixtures/grok-lean-worker", "--detach", "--deployment", deployment, "--out", out]);
    const container = containerFor();
    const sysctl = exec(container, "cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent").trim();
    process.stdout.write(`host apparmor_restrict_unprivileged_userns=${sysctl}\n`);
    const layout = exec(container, `stat -c '%u:%g %a %F %n' ${workerHome} ${workerHome}/.grok ${workerHome}/.grok/sessions ${workerHome}/.grok/*.toml ${workerHome}/.grok/sessions/sandbox-events.jsonl`);
    process.stdout.write(layout);
    for (const expected of [
      `2200:2100 710 directory ${workerHome}\n`, `0:2200 1771 directory ${workerHome}/.grok\n`, `0:2200 1771 directory ${workerHome}/.grok/sessions\n`,
      `0:0 444 regular file ${workerHome}/.grok/config.toml\n`, `0:0 444 regular file ${workerHome}/.grok/trusted_folders.toml\n`,
      `2200:2100 640 regular`
    ]) if (!layout.includes(expected)) throw new Error(`worker home layout is missing: ${expected.trim()}`);
    const profile = exec(container, `cat ${workerHome}/.grok/sandbox.toml`);
    if (!/deny = \["\//u.test(profile)) throw new Error("worker sandbox profile has an empty deny list");
    for (const required of ["/var/lib/spawnfile/moltnet", "/var/lib/spawnfile/memory", "/run/daimon-engine-broker"]) if (!profile.includes(JSON.stringify(required))) throw new Error(`worker sandbox profile does not deny ${required}`);
    // /run denies rely on /var/run being the /run symlink (a bind mask covers both spellings); report what the image has.
    process.stdout.write(`/var/run -> ${exec(container, "readlink /var/run || echo not-a-symlink").trim()}\n`);
    const service = JSON.parse(exec(container, "cat /etc/daimon-engine-broker/service.json")) as { version: string; registrations: Array<{ model: { id: string } }> };
    if (service.version !== "noopolis.daimon.engine-broker-service.v2" || service.registrations[0]?.model.id !== "grok-4.6") throw new Error("service.json is not the declared v2 registration");
    exec(container, `setpriv --reuid 2200 --regid 2200 --clear-groups bash -c '! printf x >> ${workerHome}/.grok/trusted_folders.toml' && setpriv --reuid 2200 --regid 2200 --clear-groups bash -c '! test -r /var/lib/spawnfile/daimon/grok-subscription-realm'`);
    const wakeId = `live-${Date.now()}`;
    const wake = JSON.stringify({ agentId: "agent:grok-lean-worker", event: { version: "noopolis.daimon.wake.v1", id: wakeId, kind: "manual", text: "Reply OK.", occurredAt: new Date().toISOString() } });
    const result = exec(container, `curl -fsS -X POST -H 'content-type: application/json' -H "authorization: Bearer $SPAWNFILE_DAIMON_CONTROL_TOKEN" --data-binary @- http://127.0.0.1:19700/v1/wake <<'WAKE'\n${wake}\nWAKE`);
    process.stdout.write(`wake: ${result}\n`);
    const events = exec(container, `tail -n 5 ${workerHome}/.grok/sessions/sandbox-events.jsonl`);
    if (!events.includes("\"ProfileApplied\"") || !events.includes("\"deny_paths\"")) throw new Error("no enforced ProfileApplied event with deny_paths for the wake");
    // The ledger volume is exclusive-reattach and survives earlier runs: count only this wake's rows.
    const rows = exec(container, `cat ${usageLedger}`).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { engine: string; model?: string; turn?: string; wake: string });
    const grokRows = rows.filter((row) => row.engine === "grok" && row.wake === wakeId && typeof row.turn === "string");
    if (grokRows.length !== 1 || grokRows[0]!.model !== "grok-4.6") throw new Error(`expected exactly one broker usage row for grok-4.6, found ${grokRows.length}`);
    process.stdout.write(`${run(process.execPath, ["dist/cli/index.js", "usage", "fixtures/grok-lean-worker", "--out", out, "--deployment", deployment])}\nGROK LEAN WORKER LIVE CHECK: PASS\n`);
  } finally {
    try { run(process.execPath, ["dist/cli/index.js", "down", "fixtures/grok-lean-worker", "--compiled", out, "--deployment", deployment, "--force"]); } catch { /* reported by Docker */ }
    rmSync(out, { force: true, recursive: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
