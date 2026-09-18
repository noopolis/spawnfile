import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { trainingContainerConfigSchema } from "../container/contract.js";
import { renderTrainingBrokerProvisioning, renderTrainingSealedInputsAssertions } from "./provisioning.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { pinnedProfileAllowsNamespaceRoutes, trainingNamespaceDenialMechanism } from "./seccompRoutes.js";
import { TRAINING_SEALED_INPUTS_IDENTITY, TRAINING_SEALED_INPUTS_ROOT, TRAINING_WORKER_UID } from "./paths.js";

const run = promisify(execFile);
const registration = () => resolveTrainingGrokRegistration({ agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low" });

/**
 * The `sealed_denied` helper on its own, with a stub standing in for `setpriv`
 * so the verdict handling can be exercised on any host. The probes themselves
 * need a Linux kernel; what is testable here is the part that decides whether
 * the slot is allowed to proceed.
 */
const sealHarness = (): string => {
  const lines = renderTrainingSealedInputsAssertions();
  // Everything up to and including the namespace gate: the helpers and the classifier, without the
  // routes themselves, which need a Linux kernel and a worker uid.
  return lines.slice(0, lines.findIndex((line) => line.startsWith("seal_ns_route()")) + 1).join("\n");
};

/**
 * Drives the verdict classifier with one token, under a stub `setpriv` so it
 * runs on any host. What is testable here is the decision the slot hangs on:
 * which verdicts are allowed to proceed and which refuse.
 */
const runVerdict = async (verdict: string, namespaceAvailable = true): Promise<{ code: number; stdout: string; stderr: string }> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-sealed-verdict-"));
  await writeFile(path.join(directory, "setpriv"), '#!/bin/sh\nprintf "%s" "$SEAL_VERDICT"\nexit "${SEAL_STATUS:-0}"\n', { mode: 0o755 });
  const script = [
    `seal_diagnostic=${JSON.stringify(path.join(directory, "seal.err"))}`,
    sealHarness().split("\n").filter((line) => !line.startsWith("seal_diagnostic=")).join("\n"),
    'seal_ns_route namespace-rebind-parent "probe"'
  ].join("\n");
  return run("/bin/bash", ["--noprofile", "--norc", "-ceu", script], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, SEAL_VERDICT: verdict, SEAL_STATUS: namespaceAvailable ? "0" : "1" }
  }).then((result) => ({ code: 0, ...result })).catch((error: { code?: number; stdout?: string; stderr?: string }) =>
    ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
};

describe("the sealed inputs seal", () => {
  it("asserts the image-baked identity of the datasets' ancestor rather than trying to set it", () => {
    const script = renderTrainingSealedInputsAssertions().join("\n");
    const { uid, gid, mode } = TRAINING_SEALED_INPUTS_IDENTITY;
    expect(script).toContain(`stat -c '%u:%g %a' '${TRAINING_SEALED_INPUTS_ROOT}'`);
    expect(script).toContain(`!= "${uid}:${gid} ${mode}"`);
    // The root filesystem is read-only, so a chmod here could only ever fail or hide a broken image.
    expect(script).not.toMatch(new RegExp(`chmod [^\\n]*${TRAINING_SEALED_INPUTS_ROOT}`, "u"));
    expect(script).not.toMatch(new RegExp(`chown [^\\n]*${TRAINING_SEALED_INPUTS_ROOT}`, "u"));
  });

  it("attacks the seal the way the subject would, not the way an honest tool would", () => {
    const entry = registration();
    const script = renderTrainingSealedInputsAssertions(entry.uid, entry.privateTmp).join("\n");
    expect(script).toContain(`--reuid ${TRAINING_WORKER_UID}`);
    // Direct read, then the three routes a bubblewrap `deny` mask cannot answer.
    for (const route of ["direct-read", "namespace-unmount", "namespace-rebind-parent", "namespace-rebind $sealed_child"]) {
      expect(script, route).toContain(route);
    }
    expect(script).toContain("unshare --user --map-root-user --mount");
    expect(script).toContain(`umount -l ${TRAINING_SEALED_INPUTS_ROOT}`);
    expect(script).toContain(`mount --bind /run/training ${entry.privateTmp}/seal-parent`);
    // Per dataset, because binding the dataset's OWN mount carries no `deny` mask and is not refused for
    // locked children the way binding its parent is. A live control container handed the held-out answer
    // key to uid 2200 through exactly that route (.runtime/sealed-inputs-dac/EVIDENCE.md).
    expect(script).toContain(`for sealed_child in ${TRAINING_SEALED_INPUTS_ROOT}/*; do`);
    expect(script).toContain(`mount --bind \\"$sealed_child\\" ${entry.privateTmp}/seal-child`);
  });

  it("runs the seal assertions as part of the same provisioning a recycle replays", () => {
    const provisioning = renderTrainingBrokerProvisioning(registration()).join("\n");
    for (const line of renderTrainingSealedInputsAssertions(registration().uid)) expect(provisioning).toContain(line);
  });

  it("keeps every declared dataset strictly below the sealed root, so the seal can never be bound over", () => {
    const config = (destination: string) => ({
      version: "spawnfile.training-container.v1", dockerContext: "desktop-linux",
      inputs: [{ source: "/host/project", destination }], output: { source: "/host/out", destination: "/run/training/output" }, auth: []
    });
    expect(trainingContainerConfigSchema.parse(config(`${TRAINING_SEALED_INPUTS_ROOT}/project`)).inputs).toHaveLength(1);
    // A bind AT the sealed root would replace the image's root-owned inode with the operator's own.
    expect(() => trainingContainerConfigSchema.parse(config(TRAINING_SEALED_INPUTS_ROOT))).toThrow();
    expect(() => trainingContainerConfigSchema.parse(config("/run/training"))).toThrow();
  });

  it("refuses the slot when a route reaches the datasets, and says which one did", async () => {
    const result = await runVerdict("reachable\n");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`the sealed inputs root ${TRAINING_SEALED_INPUTS_ROOT} is REACHABLE by uid ${TRAINING_WORKER_UID} via namespace-rebind-parent`);
  });

  it("accepts the two denials that mean the kernel refused something", async () => {
    for (const verdict of ["denied at-read", "denied at-mount"]) {
      const result = await runVerdict(`${verdict}\n`);
      expect(result.code, verdict).toBe(0);
      expect(result.stdout, verdict).toContain(`sealed inputs route namespace-rebind-parent: ${verdict}`);
    }
  });

  /**
   * A route the kernel will not even let the worker attempt is a *stronger*
   * denial than DAC, so it must be a verdict of its own rather than a
   * no-verdict refusal — and it must name the layer that refused, because a
   * filtered syscall recorded as a bare "denied" reads as though DAC held.
   */
  it("treats an unopenable namespace as a real verdict and names the mechanism", async () => {
    const result = await runVerdict("", false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`sealed inputs route namespace-rebind-parent: unavailable ${trainingNamespaceDenialMechanism()}`);
    expect(result.stdout).toContain("provably cannot happen");
    // Never merged with a DAC denial: the two tokens are distinct in the log and in the attestation.
    expect(result.stdout).not.toContain("denied at-read");
  });

  it("still refuses a genuine no-verdict, and prints the diagnostic that made it unreadable before", async () => {
    for (const verdict of ["", "bash: unshare: command not found\n", "denied somehow-else\n", "SEALED-PARTIAL\n"]) {
      const result = await runVerdict(verdict);
      expect(result.code, verdict).not.toBe(0);
      expect(result.stderr, verdict).toContain("reached no verdict, so the denial is unproven");
      expect(result.stderr, verdict).toContain("stderr:");
    }
  });
});

describe("the training image's own half of the seal", () => {
  it("bakes the datasets' ancestor root-owned with no world bits on the read-only root", async () => {
    const dockerfile = await readFile(fileURLToPath(new URL("../../../../runtime-images/training/Dockerfile", import.meta.url)), "utf8");
    const { gid, mode } = TRAINING_SEALED_INPUTS_IDENTITY;
    expect(dockerfile).toContain(`mkdir -p ${TRAINING_SEALED_INPUTS_ROOT}`);
    expect(dockerfile).toContain(`chown 0:${gid} ${TRAINING_SEALED_INPUTS_ROOT}`);
    expect(dockerfile).toContain(`chmod 0${mode} ${TRAINING_SEALED_INPUTS_ROOT}`);
    // Its ancestors must stay traversable, or every deny entry under /run/training becomes unplaceable
    // and Grok refuses the whole sandbox profile.
    expect(dockerfile).toContain("chmod 0755 /run/training /run/training/output");
  });
});

describe("where the seal probes are allowed to work", () => {
  /**
   * The first live run refused every trial on
   * `sealed inputs probe namespace-rebind reached no verdict`. The cause was
   * not the pinned seccomp profile — which allows `unshare`, `mount`,
   * `umount2` and `setns` outright — but the probe's own workspace: Daimon's
   * broker provisioning closes the shared temps to `root:2000 1774` so a
   * worker "lists names only", and the probe was doing `mkdir /tmp/...` as uid
   * 2200. The `mkdir` failed, the route exited with no sentinel, and
   * fail-closed did the rest. Observed in the real runner image:
   * `mkdir: cannot create directory '/tmp/x': Permission denied`.
   *
   * The worker's private tmp (`<worker home>/tmp`, `2200:2200 0700`) is the one
   * directory it can write, and it is also the faithful attacker workspace.
   */
  it("mounts only inside the worker's own private tmp, never the closed shared temps", () => {
    const entry = registration();
    const script = renderTrainingSealedInputsAssertions(entry.uid, entry.privateTmp).join("\n");
    const targets = [...script.matchAll(/mount --bind \S+ (\S+)/gu)].map((match) => match[1]!);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.startsWith(`${entry.privateTmp}/`), `${target} must sit inside ${entry.privateTmp}`).toBe(true);
    }
    for (const closed of ["/tmp/", "/var/tmp/"]) expect(script).not.toContain(`mkdir -p ${closed}`);
  });

  it("names the mechanism behind an unavailable namespace instead of merging it into a denial", () => {
    // The pinned profile allows the route's syscalls, so a refusal cannot be blamed on seccomp.
    expect(pinnedProfileAllowsNamespaceRoutes()).toBe(true);
    expect(trainingNamespaceDenialMechanism()).toBe("kernel");
    const filtered = JSON.stringify({ syscalls: [{ names: ["mount", "umount2", "setns"], action: "SCMP_ACT_ALLOW" }] });
    expect(pinnedProfileAllowsNamespaceRoutes(filtered)).toBe(false);
    expect(trainingNamespaceDenialMechanism(filtered)).toBe("seccomp");
    // An allow that only holds with CAP_SYS_ADMIN is not an allow here: the container drops it.
    const capped = JSON.stringify({ syscalls: [{ names: [...["unshare", "mount", "umount2", "setns"]], action: "SCMP_ACT_ALLOW", includes: { caps: ["CAP_SYS_ADMIN"] } }] });
    expect(pinnedProfileAllowsNamespaceRoutes(capped)).toBe(false);
  });

  it("renders the mechanism into the script, so an unavailable route is a verdict and not a refusal", () => {
    const entry = registration();
    const script = renderTrainingSealedInputsAssertions(entry.uid, entry.privateTmp).join("\n");
    expect(script).toContain(`unavailable ${trainingNamespaceDenialMechanism()}`);
    expect(script).toContain("unshare --user --map-root-user --mount true");
  });
});
