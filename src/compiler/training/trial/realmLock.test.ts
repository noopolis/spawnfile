import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { createTrainingRealmLock } from "./realmLock.js";

const fresh = () => mkdtemp(path.join(os.tmpdir(), "spawnfile-realm-lock-"));

it("queues a second run on the same profile until the first releases, and refuses at once in fail mode", async () => {
  const directory = await fresh();
  const release = await createTrainingRealmLock({ profile: "training", label: "/out/one", directory });
  const lines: string[] = [];
  await expect(createTrainingRealmLock({ profile: "training", label: "/out/two", directory, mode: "fail" }))
    .rejects.toThrow(/held by pid \d+ \(\/out\/one\)/u);
  let acquired = false;
  const waiting = createTrainingRealmLock({ profile: "training", label: "/out/two", directory, pollMs: 5, report: (line) => lines.push(line) })
    .then((next) => { acquired = true; return next; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(acquired).toBe(false);
  expect(lines[0]).toMatch(/held by pid .*waiting for it/u);
  // Another profile is another login: it never waits.
  await (await createTrainingRealmLock({ profile: "other", label: "/out/three", directory, mode: "fail" }))();
  await release();
  await (await waiting)();
  expect(acquired).toBe(true);
});

it("is released when the holding process dies without releasing it", async () => {
  const directory = await fresh();
  const module = path.resolve("src/compiler/training/trial/realmLock.ts");
  const child = spawn(process.execPath, ["--import", "tsx", "-e",
    `const { createTrainingRealmLock } = await import(${JSON.stringify(module)}); await createTrainingRealmLock({ profile: "training", label: "child", directory: ${JSON.stringify(directory)} }); console.log("held"); setInterval(() => {}, 1000);`],
    { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("held")) resolve(); }));
  await expect(createTrainingRealmLock({ profile: "training", label: "parent", directory, mode: "fail" })).rejects.toThrow(/held by/u);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));
  await (await createTrainingRealmLock({ profile: "training", label: "parent", directory, mode: "fail" }))();
}, 30_000);
