import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), moltnet = path.resolve(process.env.SPAWNFILE_TEST_MOLTNET_SOURCE ?? path.resolve(repository, "..", "moltnet"));

test("literal dirty-tree Moltnet archive wrapper emits an amd64 provenance-bound consumable release", { timeout: 360_000 }, () => {
  execFileSync("docker", ["version"], { stdio: "ignore" }); const temporary = mkdtempSync(path.join(repository, ".spawnfile-moltnet-docker-"));
  try {
    const closure = path.join(temporary, "go-closure"), sourceTar = path.join(temporary, "source.tar"), dependencyTar = path.join(temporary, "dependencies.tar"), release = path.join(temporary, "release"); mkdirSync(release);
    execFileSync("npm", ["run", "--silent", "prepare:linux-amd64-go-closure", "--", moltnet, closure], { cwd: repository, stdio: "inherit" });
    execFileSync("npm", ["run", "--silent", "bundle:source-provenance", "--", "--build-source", moltnet, sourceTar], { cwd: repository, stdio: "ignore" });
    execFileSync("npm", ["run", "--silent", "bundle:source-provenance", "--", "--go-dependencies", closure, dependencyTar], { cwd: repository, stdio: "inherit" });
    execFileSync("npm", ["run", "--silent", "build:local-moltnet"], { cwd: repository, env: { ...process.env, MOLTNET_TARGET_GOARCH: "amd64", SPAWNFILE_MOLTNET_GO_DEPENDENCY_BUNDLE: dependencyTar, SPAWNFILE_MOLTNET_LOCAL_RELEASE_OUTPUT: release, SPAWNFILE_MOLTNET_SOURCE_BUNDLE: sourceTar, SPAWNFILE_MOLTNET_SOURCE_DIR: moltnet }, stdio: "inherit" });
    const stamp = JSON.parse(readFileSync(path.join(release, "local_moltnet_release_stamp_amd64.json"), "utf8"));
    assert.equal(stamp.arch, "amd64"); assert.equal(stamp.source_inputs.mode, "source-bundle"); assert.match(stamp.source_inputs.source_sha256, /^sha256:[a-f0-9]{64}$/u); assert.match(stamp.source_inputs.dependencies_sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(readFileSync(path.join(release, stamp.asset)).length > 1_000_000);
    execFileSync("node", ["--import", "tsx", "--input-type=module", "-e", `import {readLocalMoltnetReleaseIdentity as read} from './src/compiler/localMoltnetAuthority.ts'; const value=await read(${JSON.stringify(release)},'amd64',${JSON.stringify(process.arch === "arm64" ? "arm64" : "amd64")}); if(value.source_inputs?.source_sha256!==value.source_sha256) process.exit(2);`], { cwd: repository, stdio: "inherit" });
  } finally { rmSync(temporary, { force: true, recursive: true }); }
});
