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
import { TRAINING_SEALED_INPUTS_IDENTITY, TRAINING_SEALED_INPUTS_ROOT, TRAINING_WORKER_UID } from "./paths.js";

const run = promisify(execFile);
const registration = () => resolveTrainingGrokRegistration({ agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low" });

/**
 * The `sealed_denied` helper on its own, with a stub standing in for `setpriv`
 * so the verdict handling can be exercised on any host. The probes themselves
 * need a Linux kernel; what is testable here is the part that decides whether
 * the slot is allowed to proceed.
 */
const verdictScript = (): string => {
  const lines = renderTrainingSealedInputsAssertions();
  return lines.slice(0, lines.indexOf("}") + 1).join("\n");
};

const runVerdict = async (output: string): Promise<{ code: number; stdout: string; stderr: string }> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-sealed-verdict-"));
  await writeFile(path.join(directory, "setpriv"), '#!/bin/sh\nprintf "%s" "$SEALED_PROBE_OUTPUT"\n', { mode: 0o755 });
  const script = `${verdictScript()}\nsealed_denied "probe" namespace-rebind\n`;
  return run("/bin/bash", ["--noprofile", "--norc", "-ceu", script], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, SEALED_PROBE_OUTPUT: output }
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
    const script = renderTrainingSealedInputsAssertions().join("\n");
    expect(script).toContain(`--reuid ${TRAINING_WORKER_UID}`);
    // Direct read, then the two routes a bubblewrap `deny` mask cannot answer.
    expect(script).toContain("direct-read");
    expect(script).toContain("namespace-unmount");
    expect(script).toContain("namespace-rebind");
    expect(script).toContain("unshare --user --map-root-user --mount");
    expect(script).toContain(`umount -l ${TRAINING_SEALED_INPUTS_ROOT}`);
    expect(script).toContain("mount --bind /run/training /tmp/.sealed-probe");
    // Per dataset too: binding the dataset's OWN mount somewhere fresh carries no `deny` mask and is not
    // refused for locked children the way binding their parent is. A live control container handed the
    // held-out answer key to uid 2200 through exactly that route (.runtime/sealed-inputs-dac/EVIDENCE.md).
    expect(script).toContain(`for sealed_child in ${TRAINING_SEALED_INPUTS_ROOT}/*; do`);
    expect(script).toContain("mount --bind '$sealed_child' /tmp/.sealed-probe-child");
    expect(script).toContain('cat \\"$sealed_child\\"/*');
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

  it("refuses the slot when a probe reaches the datasets, and says which route did", async () => {
    const result = await runVerdict("SEALED-REACHABLE\n");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`the sealed inputs root ${TRAINING_SEALED_INPUTS_ROOT} is reachable by uid ${TRAINING_WORKER_UID} via namespace-rebind`);
  });

  it("refuses the slot when a probe reaches no verdict at all, instead of reading silence as a denial", async () => {
    for (const output of ["", "bash: unshare: command not found\n", "SEALED-PARTIAL\n"]) {
      const result = await runVerdict(output);
      expect(result.code, output).not.toBe(0);
      expect(result.stderr, output).toContain("reached no verdict, so the denial is unproven");
    }
  });

  it("accepts an observed denial, and a worker that cannot open a namespace at all", async () => {
    expect((await runVerdict("SEALED-DENIED\n")).code).toBe(0);
    expect((await runVerdict("SEALED-NO-NAMESPACE\n")).code).toBe(0);
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
