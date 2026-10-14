import { mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preparationFixture, imageDocker } from "./fixtures.test-helper.js";
import { prepareTraining } from "./prepare.js";

const race = vi.hoisted(() => ({ active: false, inject: false, settled: Promise.resolve(), target: "" }));
vi.mock("./inputs.js", async importOriginal => {
  const original = await importOriginal<typeof import("./inputs.js")>();
  return { ...original, stageInput: async (input: import("./inputs.js").PlannedInput, target: string) => {
    if (!race.inject) return original.stageInput(input, target);
    if (input.id === "project") throw Object.assign(Error("EEXIST: copyfile tracked overlay"), { code: "EEXIST" });
    race.active = true; race.target = target;
    race.settled = new Promise<void>(resolve => setTimeout(resolve, 40)).then(async () => {
      await mkdir(target, { recursive: true }); race.active = false;
    });
    await race.settled; return target;
  } };
});
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: async (...args: Parameters<typeof original.rm>) => {
    if (race.inject && race.active) throw Object.assign(Error("ENOTEMPTY: rmdir active staging"), { code: "ENOTEMPTY" });
    return original.rm(...args);
  } };
});
const roots: string[] = [];
afterEach(async () => {
  await race.settled; race.inject = false;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
it("settles every input before cleanup so ENOTEMPTY cannot mask the original staging failure", async () => {
  const f = await preparationFixture(); roots.push(f.root); race.inject = true;
  await expect(prepareTraining({ configPath: f.configPath, context: f.context, args: f.args, dryRun: false,
    process: imageDocker().process, timeoutMs: 30000, packageRoot: path.join(f.root, "own"),
    streams: { stdout() {}, stderr() {} } }), "settled cleanup guarantee").rejects.toThrow("EEXIST: copyfile");
  expect(race.active, "settled cleanup guarantee").toBe(false);
  await expect(access(path.dirname(race.target)), "settled cleanup guarantee").rejects.toThrow("ENOENT");
});
