import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  proveExactDockerResourcePresent,
  removeExactDockerResource
} from "./dockerResources.js";
import {
  DockerResourceProviderError,
  createDockerResourceSpec,
  type DockerResourceExecutor,
  type DockerResourceKind
} from "./dockerResourcesProvider.js";

const handle = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const spec = (kind: DockerResourceKind) => createDockerResourceSpec({
  kind,
  operationHandle: handle("o"),
  requestDigest: `sha256:${"d".repeat(64)}`,
  runId: "run-one",
  selectedTargetHandle: handle("t")
});

const fixture = (input: {
  readonly foreign?: "labels" | "shape";
  readonly kind: DockerResourceKind;
  readonly removal?: "ambiguous_absent" | "ambiguous_foreign" | "ambiguous_present"
    | "bad_ack" | "not_found_absent" | "success" | "success_present";
  readonly startsPresent?: boolean;
}) => {
  const resource = spec(input.kind);
  const calls: string[][] = [];
  const commandOptions: Array<{ readonly signal?: AbortSignal; readonly timeout: number }> = [];
  let present = input.startsPresent ?? true;
  let foreignAfterRemoval = false;
  let unrelatedRemovals = 0;
  const executor: DockerResourceExecutor = async (_file, args, options) => {
    calls.push(args);
    commandOptions.push(options);
    const subject = input.kind === "data_network" ? "network" : "volume";
    if (args[2] === subject && args[3] === "inspect") {
      if (!present) throw new DockerResourceProviderError("not_found");
      const labels = input.foreign === "labels" || foreignAfterRemoval
        ? { ...resource.labels, spawnfile_resource_v1_run: "foreign" }
        : resource.labels;
      return {
        stderr: "",
        stdout: JSON.stringify([input.foreign === "shape"
          ? { Labels: labels, Name: resource.name }
          : input.kind === "data_network"
          ? { Internal: true, Labels: labels, Name: resource.name }
          : { Labels: labels, Name: resource.name }])
      };
    }
    if (args[2] === subject && args[3] === "rm") {
      if (args[4] !== resource.name) {
        unrelatedRemovals += 1;
        throw new Error("unrelated resource");
      }
      if (input.removal === "ambiguous_present") throw new Error("transport");
      if (input.removal === "ambiguous_foreign") {
        foreignAfterRemoval = true;
        throw new Error("transport");
      }
      if (input.removal !== "success_present") present = false;
      if (input.removal === "not_found_absent") {
        throw new DockerResourceProviderError("not_found");
      }
      if (input.removal === "ambiguous_absent") throw new Error("transport");
      return { stderr: "", stdout: input.removal === "bad_ack" ? resource.name : `${resource.name}\n` };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return {
    calls,
    commandOptions,
    executor,
    getPresent: () => present,
    getUnrelatedRemovals: () => unrelatedRemovals,
    resource
  };
};

describe("exact Docker resource cleanup", () => {
  it.each(["data_network", "evidence_volume"] as const)(
    "proves one exact present %s without mutation or enumeration",
    async (kind) => {
      const value = fixture({ kind });
      const signal = new AbortController().signal;
      await expect(proveExactDockerResourcePresent(value.resource, {
        context: "production",
        executor: value.executor,
        signal,
        timeoutMs: 7_777
      })).resolves.toBeUndefined();
      expect(value.calls).toEqual([[
        "--context", "production", kind === "data_network" ? "network" : "volume",
        "inspect", "--format", value.resource.inspectionFormat, value.resource.name
      ]]);
      expect(value.calls.flat()).not.toEqual(expect.arrayContaining([
        "list", "ls", "ps", "prune", "filter", "rm", "--force"
      ]));
      expect(value.commandOptions).toEqual([{ signal, timeout: 7_777 }]);
      expect(value.getPresent()).toBe(true);
      expect(value.getUnrelatedRemovals()).toBe(0);
    }
  );

  it("refuses to certify absent, malformed, or foreign evidence without mutation", async () => {
    for (const value of [
      fixture({ kind: "evidence_volume", startsPresent: false }),
      fixture({ foreign: "labels", kind: "evidence_volume" }),
      fixture({ foreign: "shape", kind: "data_network" })
    ]) {
      await expect(proveExactDockerResourcePresent(value.resource, {
        context: "production",
        executor: value.executor,
        timeoutMs: 10_000
      })).rejects.toThrow("Docker resource mutation failed");
      expect(value.calls).toHaveLength(1);
      expect(value.calls.some((call) => call.includes("rm"))).toBe(false);
      expect(value.getUnrelatedRemovals()).toBe(0);
    }
  });

  it("rejects forged preserve specs and options before provider use", async () => {
    const value = fixture({ kind: "evidence_volume" });
    const forgedSpec = {
      ...value.resource,
      args: [...value.resource.args.slice(0, -1), "--force"],
      name: "--force"
    };
    for (const [candidateSpec, candidateOptions] of [
      [forgedSpec, {
        context: "production",
        executor: value.executor,
        timeoutMs: 10_000
      }],
      [value.resource, {
        context: "--bad",
        executor: value.executor,
        timeoutMs: 10_000
      }],
      [value.resource, {
        context: "production",
        executor: value.executor,
        timeoutMs: 0
      }]
    ] as const) {
      await expect(proveExactDockerResourcePresent(
        candidateSpec, candidateOptions
      )).rejects.toThrow("Docker resource mutation failed");
    }
    expect(value.calls).toHaveLength(0);
    expect(value.getPresent()).toBe(true);
  });

  it.each(["data_network", "evidence_volume"] as const)(
    "removes one exact %s with exact argv, proves absence, and never enumerates",
    async (kind) => {
      const value = fixture({ kind, removal: "success" });
      const signal = new AbortController().signal;
      await expect(removeExactDockerResource(value.resource, {
        context: "production",
        executor: value.executor,
        signal,
        timeoutMs: 10_000
      })).resolves.toBeUndefined();
      const subject = kind === "data_network" ? "network" : "volume";
      expect(value.calls).toEqual([
        ["--context", "production", subject, "inspect", "--format",
          value.resource.inspectionFormat, value.resource.name],
        ["--context", "production", subject, "rm", value.resource.name],
        ["--context", "production", subject, "inspect", "--format",
          value.resource.inspectionFormat, value.resource.name]
      ]);
      expect(value.calls.flat()).not.toEqual(expect.arrayContaining([
        "list", "ls", "ps", "prune", "filter", "--force", "disconnect"
      ]));
      expect(value.getPresent()).toBe(false);
      expect(value.getUnrelatedRemovals()).toBe(0);
      expect(value.commandOptions).toEqual([
        { signal, timeout: 10_000 },
        { signal, timeout: 10_000 },
        { signal, timeout: 10_000 }
      ]);
    }
  );

  it("converges when the exact resource is already absent or removal became absent ambiguously", async () => {
    const absent = fixture({ kind: "data_network", startsPresent: false });
    await expect(removeExactDockerResource(absent.resource, {
      context: "production", executor: absent.executor, timeoutMs: 10_000
    })).resolves.toBeUndefined();
    expect(absent.calls).toHaveLength(1);

    const ambiguous = fixture({ kind: "evidence_volume", removal: "ambiguous_absent" });
    await expect(removeExactDockerResource(ambiguous.resource, {
      context: "production", executor: ambiguous.executor, timeoutMs: 10_000
    })).resolves.toBeUndefined();
    expect(ambiguous.calls).toHaveLength(3);

    const notFound = fixture({ kind: "data_network", removal: "not_found_absent" });
    await expect(removeExactDockerResource(notFound.resource, {
      context: "production", executor: notFound.executor, timeoutMs: 10_000
    })).resolves.toBeUndefined();
    expect(notFound.calls).toHaveLength(3);
  });

  it.each(["labels", "shape"] as const)("fails closed for foreign %s before remove", async (foreignKind) => {
    const foreign = fixture({ foreign: foreignKind, kind: "data_network" });
    await expect(removeExactDockerResource(foreign.resource, {
      context: "production", executor: foreign.executor, timeoutMs: 10_000
    })).rejects.toThrow("Docker resource mutation failed");
    expect(foreign.calls).toHaveLength(1);
    expect(foreign.getPresent()).toBe(true);
    expect(foreign.getUnrelatedRemovals()).toBe(0);
  });

  it("fails closed for ambiguous removal still present or a noncanonical acknowledgement", async () => {
    const ambiguous = fixture({ kind: "evidence_volume", removal: "ambiguous_present" });
    await expect(removeExactDockerResource(ambiguous.resource, {
      context: "production", executor: ambiguous.executor, timeoutMs: 10_000
    })).rejects.toThrow("Docker resource mutation failed");
    expect(ambiguous.calls).toHaveLength(3);
    expect(ambiguous.getPresent()).toBe(true);
    expect(ambiguous.getUnrelatedRemovals()).toBe(0);

    const foreignReplacement = fixture({ kind: "data_network", removal: "ambiguous_foreign" });
    await expect(removeExactDockerResource(foreignReplacement.resource, {
      context: "production", executor: foreignReplacement.executor, timeoutMs: 10_000
    })).rejects.toThrow("Docker resource mutation failed");
    expect(foreignReplacement.calls).toHaveLength(3);
    expect(foreignReplacement.getPresent()).toBe(true);

    const exactReplacement = fixture({ kind: "data_network", removal: "success_present" });
    await expect(removeExactDockerResource(exactReplacement.resource, {
      context: "production", executor: exactReplacement.executor, timeoutMs: 10_000
    })).rejects.toThrow("Docker resource mutation failed");
    expect(exactReplacement.calls).toHaveLength(3);
    expect(exactReplacement.getPresent()).toBe(true);

    const badAck = fixture({ kind: "evidence_volume", removal: "bad_ack" });
    await expect(removeExactDockerResource(badAck.resource, {
      context: "production", executor: badAck.executor, timeoutMs: 10_000
    })).rejects.toThrow("Docker resource mutation failed");
    expect(badAck.calls).toHaveLength(2);
    expect(badAck.getPresent()).toBe(false);
  });

  it("rejects a forged option-like name before any provider call", async () => {
    const value = fixture({ kind: "data_network" });
    const forged = {
      ...value.resource,
      args: [...value.resource.args.slice(0, -1), "--force"],
      name: "--force"
    };
    await expect(removeExactDockerResource(forged, {
      context: "production", executor: value.executor, timeoutMs: 10_000
    })).rejects.toThrow("Docker resource mutation failed");
    expect(value.calls).toHaveLength(0);
    expect(value.getPresent()).toBe(true);
    expect(value.getUnrelatedRemovals()).toBe(0);
  });
});
