import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireExclusiveVolumeReservations,
  assertCandidateContainerReady,
  assertContainerStopped,
  assertExclusiveVolumesAvailable,
  inspectContainerSnapshot,
  restorePreviousContainer,
  rollbackCandidateContainer
} from "./consumeImageLifecycle.js";
import type { DockerCommandRunner } from "./dockerRunner.js";
import type { DistributionReport } from "./types.js";

afterEach(() => vi.useRealTimers());

const candidateId = "c".repeat(64);
const previousId = "d".repeat(64);
const snapshot = (id: string, name: string, running: boolean): Buffer => Buffer.from([
  JSON.stringify(id), JSON.stringify(`/${name}`), JSON.stringify(running)
].join("\n"));
const ready = (id: string, name: string, state: object): Buffer => Buffer.from([
  JSON.stringify(id), JSON.stringify(`/${name}`), JSON.stringify(state)
].join("\n"));
const exclusiveReport = {
  persistent_mounts: [{
    durability: "persistent", id: "realm", kind: "volume",
    lifecycle: "exclusive-reattach", target: "/realm"
  }]
} as DistributionReport;

describe("image deployment lifecycle", () => {
  it("distinguishes authoritative absence from indeterminate inspect failure", async () => {
    await expect(inspectContainerSnapshot(
      async () => snapshot(candidateId, "candidate", true), "candidate"
    )).resolves.toEqual({ id: candidateId, name: "candidate", running: true });
    await expect(inspectContainerSnapshot(
      async () => { throw new Error("No such container: candidate"); }, "candidate"
    )).resolves.toBeNull();
    await expect(inspectContainerSnapshot(
      async () => { throw new Error("daemon unavailable"); }, "candidate"
    )).rejects.toThrow(/Unable to determine container identity state/u);
  });

  it("accepts running healthy state and rejects invalid, drifted, or terminal state", async () => {
    await expect(assertCandidateContainerReady(async () => ready(candidateId, "candidate", {
      Health: { Status: "healthy" }, Running: true, Status: "running"
    }), candidateId, "candidate")).resolves.toBeUndefined();
    await expect(assertCandidateContainerReady(async () => Buffer.from("not-json"), candidateId, "candidate"))
      .rejects.toThrow(/invalid readiness state/u);
    await expect(assertCandidateContainerReady(async () => ready(candidateId, "peer", {
      Running: true, Status: "running"
    }), candidateId, "candidate")).rejects.toThrow(/identity did not match/u);
    await expect(assertCandidateContainerReady(async () => ready(candidateId, "candidate", {
      Running: false, Status: "exited"
    }), candidateId, "candidate")).rejects.toThrow(/did not become ready/u);
  });

  it("waits while a running candidate health check is starting", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const readiness = assertCandidateContainerReady(async () => ready(candidateId, "candidate",
      attempts++ === 0
        ? { Health: { Status: "starting" }, Running: true, Status: "running" }
        : { Health: { Status: "healthy" }, Running: true, Status: "running" }
    ), candidateId, "candidate");
    await vi.runAllTimersAsync();
    await expect(readiness).resolves.toBeUndefined();
  });

  it("allows the selected container to occupy its realm and blocks a peer", async () => {
    await expect(assertExclusiveVolumesAvailable(
      exclusiveReport, "lineage", "selected", async () => Buffer.from("selected\n")
    )).resolves.toBeUndefined();
    await expect(assertExclusiveVolumesAvailable(
      exclusiveReport, "lineage", "selected", async () => Buffer.from("peer\n")
    )).rejects.toThrow(/another running deployment/u);
  });

  it("serializes concurrent volume admission and releases only exact reservation identity", async () => {
    const reservations = new Map<string, { id: string; labels: Record<string, string> }>();
    let sequence = 0;
    const calls: string[][] = [];
    const runDocker: DockerCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === "container" && args[1] === "create") {
        const name = args[args.indexOf("--name") + 1]!;
        if (reservations.has(name)) throw new Error("name conflict");
        const labels: Record<string, string> = {};
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] !== "--label") continue;
          const [key, value] = args[index + 1]!.split("=", 2);
          labels[key!] = value!;
        }
        const id = `${++sequence}`.padStart(64, "e");
        reservations.set(name, { id, labels });
        return Buffer.from(id);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        const record = [...reservations.values()].find((value) => value.id === args[args.length - 1]);
        if (!record) throw new Error("No such container");
        return Buffer.from(`${JSON.stringify(record.id)}\n${JSON.stringify(record.labels)}`);
      }
      if (args[0] === "container" && args[1] === "rm") {
        const entry = [...reservations.entries()].find(([, value]) => value.id === args[2]);
        if (!entry) throw new Error("No such container");
        reservations.delete(entry[0]);
        return Buffer.from("");
      }
      if (args[0] === "ps") return Buffer.from("");
      throw new Error("unexpected Docker call");
    };
    const contenders = await Promise.allSettled([
      acquireExclusiveVolumeReservations(exclusiveReport, "lineage", "selected", "image:1", runDocker),
      acquireExclusiveVolumeReservations(exclusiveReport, "lineage", "selected", "image:1", runDocker)
    ]);
    const winner = contenders.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireExclusiveVolumeReservations>>> => result.status === "fulfilled");
    expect(winner).toBeDefined();
    expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
    await winner!.value.release();
    const retry = await acquireExclusiveVolumeReservations(
      exclusiveReport, "lineage", "selected", "image:1", runDocker
    );
    await retry.release();
    await retry.release();
    expect(reservations.size).toBe(0);
    expect(calls.filter((call) => call[0] === "container" && call[1] === "rm")).toHaveLength(2);
  });

  it("removes a verified failed candidate by id and restores prior name and state", async () => {
    const values = new Map<string, { id: string; name: string; running: boolean }>([
      [candidateId, { id: candidateId, name: "candidate", running: true }],
      [previousId, { id: previousId, name: "backup", running: false }]
    ]);
    const calls: string[][] = [];
    const runDocker: DockerCommandRunner = async (args) => {
      calls.push(args);
      const reference = args[0] === "rename" ? args[1]! : args[args.length - 1]!;
      const value = [...values.values()].find((item) => item.id === reference || item.name === reference);
      if (args[0] === "container" && args[1] === "inspect") {
        if (!value) throw new Error("No such container");
        return snapshot(value.id, value.name, value.running);
      }
      if (args[0] === "rm") { values.delete(value!.id); return Buffer.from(""); }
      if (args[0] === "rename") { value!.name = args[2]!; return Buffer.from(""); }
      if (args[0] === "start") { value!.running = true; return Buffer.from(""); }
      throw new Error("unexpected");
    };
    await rollbackCandidateContainer(
      runDocker, candidateId, "candidate",
      { id: previousId, name: "candidate", running: true }, "backup"
    );
    expect(calls).toContainEqual(["rm", "-f", candidateId]);
    expect(calls).toContainEqual(["start", previousId]);
    expect(values.get(previousId)).toMatchObject({ name: "candidate", running: true });
  });

  it("never deletes by an ambiguous candidate name", async () => {
    const runDocker = vi.fn<DockerCommandRunner>(async () => Buffer.from(""));
    await rollbackCandidateContainer(runDocker, undefined, "candidate", null, "backup");
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("fails closed across malformed identity, stopped-state, and rollback branches", async () => {
    await expect(inspectContainerSnapshot(async () => Buffer.from("bad"), "candidate"))
      .rejects.toThrow(/invalid identity state/u);
    await expect(inspectContainerSnapshot(async () => { throw "transport"; }, "candidate"))
      .rejects.toThrow(/Unable to determine container identity state/u);
    await expect(assertCandidateContainerReady(async () => Buffer.from(""), "invalid", "candidate"))
      .rejects.toThrow(/invalid identity/u);
    await expect(assertContainerStopped(
      async () => { throw new Error("No such container"); }, "candidate", candidateId
    )).rejects.toThrow(/verified stopped state/u);
    await expect(assertContainerStopped(
      async () => snapshot(previousId, "candidate", false), "candidate", candidateId
    )).rejects.toThrow(/verified stopped state/u);
    await expect(assertContainerStopped(
      async () => snapshot(candidateId, "candidate", true), "candidate", candidateId
    )).rejects.toThrow(/verified stopped state/u);
    await expect(rollbackCandidateContainer(
      async () => snapshot(candidateId, "peer", true), candidateId, "candidate", null, "backup"
    )).rejects.toThrow(/candidate cleanup/u);
    await expect(rollbackCandidateContainer(
      async () => { throw new Error("No such container"); }, undefined, "candidate",
      { id: previousId, name: "candidate", running: true }, "backup"
    )).rejects.toThrow(/prior restore/u);
  });

  it("restores a prior stopped container by stopping a running renamed backup", async () => {
    const value = { id: previousId, name: "backup", running: true };
    const runDocker: DockerCommandRunner = async (args) => {
      if (args[0] === "container" && args[1] === "inspect") {
        return snapshot(value.id, value.name, value.running);
      }
      if (args[0] === "rename") { value.name = args[2]!; return Buffer.from(""); }
      if (args[0] === "stop") { value.running = false; return Buffer.from(""); }
      throw new Error("unexpected");
    };
    await restorePreviousContainer(
      runDocker, { id: previousId, name: "candidate", running: false }, "backup", "candidate"
    );
    expect(value).toEqual({ id: previousId, name: "candidate", running: false });
  });

  it("rejects invalid reservation identity and redacts release failures", async () => {
    await expect(acquireExclusiveVolumeReservations(
      exclusiveReport, "lineage", "selected", "image:1",
      async (args) => args.includes("create") ? Buffer.from("invalid") : Buffer.from("")
    )).rejects.toThrow(/returned invalid identity/u);

    const id = "a".repeat(64);
    let labels: Record<string, string> = {};
    const runDocker: DockerCommandRunner = async (args) => {
      if (args.includes("create")) {
        labels = Object.fromEntries(args.flatMap((arg, index) =>
          arg === "--label" ? [args[index + 1]!.split("=", 2) as [string, string]] : []));
        return Buffer.from(id);
      }
      if (args.includes("inspect")) return Buffer.from(`${JSON.stringify(id)}\n${JSON.stringify(labels)}`);
      if (args[0] === "ps") return Buffer.from("");
      if (args.includes("rm")) throw new Error("provider-secret-diagnostic");
      throw new Error("unexpected");
    };
    const reservation = await acquireExclusiveVolumeReservations(
      exclusiveReport, "lineage", "selected", "image:1", runDocker
    );
    await expect(reservation.release()).rejects.toThrow(
      "Unable to release exclusive persistent mount reservation"
    );
  });
});
