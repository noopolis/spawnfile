import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const gate = "node --experimental-strip-types --test scripts/native-helper-artifacts.test.ts scripts/native-helper-integration.test.ts";

test("PR/main and publish workflows explicitly configure QEMU and run native syscall gates", async () => {
  for (const workflow of [".github/workflows/test.yml", ".github/workflows/publish.yml"]) {
    const source = await readFile(workflow, "utf8");
    assert.match(source, /docker\/setup-qemu-action@v3/u); assert.match(source, /platforms: amd64,arm64/u); assert.match(source, /npm run build:native/u); assert.ok(source.includes(gate));
  }
});

test("native helper build uses only the pinned compiler image", async () => {
  const dockerfile = await readFile("src/deployment/native/Dockerfile", "utf8");
  assert.match(dockerfile, /^FROM gcc:14\.2\.0@sha256:[a-f0-9]{64} AS build$/mu); assert.match(dockerfile, /gcc -dumpfullversion/u); assert.doesNotMatch(dockerfile, /apk add|apt-get|dnf|yum/u);
});

test("normal package build copies shipped helpers without invoking the native rebuild", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(packageJson.scripts.build, /copyArtifacts\.ts/u);
  assert.doesNotMatch(packageJson.scripts.build, /native\/build\.ts|docker/u);
  assert.equal(packageJson.scripts["build:native"], "node --experimental-strip-types ./src/deployment/native/build.ts");
});

test("PR/main runs the same offline source provenance gate and inputs as release", async () => {
  type Step = { name: string; run?: string; env?: Record<string, string>; uses?: string; with?: Record<string, string> };
  type Job = { if?: string; "timeout-minutes": number; steps: Step[] };
  const ci = parse(await readFile(".github/workflows/test.yml", "utf8")) as {
    on: { pull_request: { paths?: string[]; "paths-ignore"?: string[] } | null; push: { branches: string[]; paths?: string[]; "paths-ignore"?: string[] } };
    jobs: Record<string, Job>;
  };
  const release = parse(await readFile(".github/workflows/publish.yml", "utf8")) as { jobs: { publish: Job } };
  assert.ok(Object.hasOwn(ci.on, "pull_request"));
  assert.ok(ci.on.push.branches.includes("main"));
  assert.equal(ci.on.push.paths, undefined);
  assert.equal(ci.on.push["paths-ignore"], undefined);
  assert.equal(ci.on.pull_request?.paths, undefined);
  assert.equal(ci.on.pull_request?.["paths-ignore"], undefined);
  const job = ci.jobs["source-provenance"];
  assert.ok(job);
  assert.equal(job.if, undefined, "the gate must run on every PR/main revision");
  assert.ok(job["timeout-minutes"] >= 15 && job["timeout-minutes"] <= 30);
  for (const name of ["Resolve exact Daimon provenance fixture revision", "Check out Daimon provenance fixture", "Fetch the pinned linux-x86_64 Grok CLI",
    "Verify Git-free offline linux/amd64 source build"]) {
    const actual = job.steps.find((step) => step.name === name);
    const expected = release.jobs.publish.steps.find((step) => step.name === name);
    assert.ok(actual && expected, name);
    assert.deepEqual(actual.with, expected.with, name);
    assert.deepEqual(actual.env, expected.env, name);
    assert.equal(actual.run?.replace("env -u TYPESAFE_API_KEY ", ""), expected.run, name);
  }
  assert.equal(job.steps.find((step) => step.name === "Check out Daimon provenance fixture")?.with?.ref,
    "${{ steps.daimon-provenance.outputs.ref }}");
  for (const candidate of [job, release.jobs.publish]) {
    const resolve = candidate.steps.findIndex((step) => step.name === "Resolve exact Daimon provenance fixture revision");
    const checkout = candidate.steps.findIndex((step) => step.name === "Check out Daimon provenance fixture");
    assert.ok(resolve >= 0 && checkout > resolve, "resolve the pin before checkout, or an empty ref follows upstream HEAD");
  }
  const gate = job.steps.findIndex((step) => step.run?.includes("npm run test:source-provenance-docker"));
  const build = job.steps.findIndex((step) => step.run?.includes("npm run build"));
  assert.ok(build >= 0 && gate > build, "the gate requires compiled materializer output");
});
