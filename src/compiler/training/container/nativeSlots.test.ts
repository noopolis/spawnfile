import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { dockerFixture, fixture, image } from "./fixtures.test-helper.js";
import { launchTrainingContainer } from "./launch.js";
import { nativeTrainingSlotsDocument } from "./nativeSlots.js";
import { prepareTrainingContainer } from "./prepare.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each([1, 2, 4, 8])("mounts %i native descriptors read-only with host uid and disjoint ports, without broker roots", async slots => {
  const f = await fixture(); roots.push(f.root);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, slots }));
  let observed = false;
  const docker = dockerFixture(async args => {
    if (args[2] !== "create") return undefined;
    const mounts = args.filter(arg => arg.includes("dst=/run/spawnfile-training/slots.json"));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatch(/,readonly$/u);
    const file = mounts[0]!.split("src=")[1]!.split(",")[0]!;
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schema: "spawnfile.training-slots.v2",
      slots: Array.from({ length: slots }, (_, index) => ({ index, workerUid: process.getuid!(),
        isolation: "shared-uid", roots: {}, ports: { base: 20000 + index * 100, count: 100 } }))
    });
    expect(args).toContain(`${process.getuid!()}:${process.getgid!()}`);
    for (const [target, size, mode] of [["/tmp", slots, "1777"], ["/work", slots * 4, "700"], ["/home/training", slots, "700"]]) {
      expect(args).toContain(`${target}:rw,nosuid,nodev,size=${size}g,uid=${process.getuid!()},gid=${process.getgid!()},mode=${mode}`);
    }
    expect(args[args.indexOf("--pids-limit") + 1]).toBe(String(512 * slots));
    expect(args).not.toContain("SPAWNFILE_TRAINING_MODEL_REQUEST_CAP=broker");
    expect(args.some(arg => arg.includes("request-budget"))).toBe(false);
    observed = true;
    return undefined;
  });
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 10000, streams: { stdout() {}, stderr() {} }, process: docker.process })).toBe(0);
  expect(observed).toBe(true);
});

it("rejects native oversubscription and malformed or duplicate concurrency before Docker", async () => {
  const f = await fixture(); roots.push(f.root);
  for (const args of [["--concurrency", "3"], ["--concurrency=3"], ["--concurrency"], ["--concurrency", "0"],
    ["--concurrency", "2", "--concurrency=1"]]) {
    await expect(prepareTrainingContainer({ ...f.config, slots: 2 }, f.context, [...f.args, ...args])).rejects.toThrow("concurrency");
  }
  const prepared = await prepareTrainingContainer({ ...f.config, slots: 2 }, f.context, [...f.args, "--concurrency=2"]);
  expect(prepared.args.slice(-2)).toEqual(["--concurrency", "2"]);
});

it("bounds native slots and requires an honest non-root uid", () => {
  for (const slots of [0, 9, 1.5]) expect(() => nativeTrainingSlotsDocument(slots, 501)).toThrow("slots");
  for (const uid of [0, -1, 1.5, 4_294_967_295]) expect(() => nativeTrainingSlotsDocument(2, uid)).toThrow("uid");
});
