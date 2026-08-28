import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gate = "node --test scripts/native-helper-artifacts.test.mjs scripts/native-helper-integration.test.mjs";

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
  assert.match(packageJson.scripts.build, /copyArtifacts\.mjs/u);
  assert.doesNotMatch(packageJson.scripts.build, /native\/build\.mjs|docker/u);
  assert.equal(packageJson.scripts["build:native"], "node ./src/deployment/native/build.mjs");
});
