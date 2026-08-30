import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSourceBundle, validateSourceBundle } from "./source-provenance-bundle.mjs";
import { renderRuntimeLinkMaterializer } from "../dist/compiler/containerRuntimeLinkMaterializer.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (file) => `sha256:${execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" }).split(" ")[0]}`;
const sha512 = (file) => `sha512:${createHash("sha512").update(readFileSync(file)).digest("hex")}`;

test("actual Daimon lock produces a real offline linux/amd64 shipped artifact and rejects tampering", { timeout: 360_000 }, () => {
  execFileSync("docker", ["version"], { stdio: "ignore" });
  const temporary = mkdtempSync(path.join(repository, ".spawnfile-source-docker-"));
  let registry;
  try {
    const closure = path.join(temporary, "closure"),
      // CI has no sibling checkout, so it points this at a fetched fixture the
      // way SPAWNFILE_TEST_MOLTNET_SOURCE already does for the Moltnet variant.
      actualDaimon = process.env.SPAWNFILE_TEST_DAIMON_SOURCE
        ? path.resolve(process.env.SPAWNFILE_TEST_DAIMON_SOURCE)
        : path.resolve(repository, "..", "daimon"),
      daimonSource = path.join(temporary, "actual-daimon-input");
    mkdirSync(daimonSource); cpSync(path.join(actualDaimon, "package.json"), path.join(daimonSource, "package.json")); cpSync(path.join(actualDaimon, "package-lock.json"), path.join(daimonSource, "package-lock.json"));
    execFileSync("npm", ["run", "--silent", "prepare:linux-amd64-closure", "--", daimonSource, closure, "0.142.3"], { cwd: repository, stdio: "inherit" });
    const sourceTar = path.join(temporary, "source.tar"), dependencyTar = path.join(temporary, "dependencies.tar");
    execFileSync("npm", ["run", "--silent", "bundle:source-provenance", "--", actualDaimon, sourceTar], { cwd: repository, stdio: "ignore" });
    execFileSync("npm", ["run", "--silent", "bundle:source-provenance", "--", "--dependencies", closure, dependencyTar], { cwd: repository, stdio: "inherit" });
    const sourceReceipt = validateSourceBundle(readFileSync(sourceTar)), dependencyReceipt = validateSourceBundle(readFileSync(dependencyTar));
    const sourceContext = path.join(temporary, "source-context"), dependencyContext = path.join(temporary, "dependency-context"), output = path.join(temporary, "output");
    mkdirSync(sourceContext); mkdirSync(dependencyContext); mkdirSync(output); cpSync(sourceTar, path.join(sourceContext, "source.tar")); cpSync(dependencyTar, path.join(dependencyContext, "dependencies.tar"));
    const args = ["build", "--network=none", "--platform", "linux/amd64", "--build-context", `source_bundle=${sourceContext}`, "--build-context", `dependency_bundle=${dependencyContext}`,
      "--output", `type=local,dest=${output}`, "--build-arg", `SOURCE_ARCHIVE_SHA256=${sourceReceipt.archive_sha256}`, "--build-arg", `DEPENDENCY_ARCHIVE_SHA256=${dependencyReceipt.archive_sha256}`,
      "--build-arg", `SOURCE_MANIFEST_SHA256=${sourceReceipt.manifest_sha256}`, "--build-arg", `DEPENDENCY_MANIFEST_SHA256=${dependencyReceipt.manifest_sha256}`,
      "-f", path.join(repository, "runtime-images", "daimon", "SourceBundle.Dockerfile"), repository];
    execFileSync("docker", args, { stdio: "inherit" });
    const identity = JSON.parse(readFileSync(path.join(output, "source-inputs.json"), "utf8"));
    assert.equal(identity.target, "linux/amd64"); assert.equal(identity.source.archive_sha256, digest(sourceTar)); assert.equal(identity.dependencies.archive_sha256, digest(dependencyTar));
    assert.match(execFileSync("tar", ["-tzf", path.join(output, "daimon.tgz")], { encoding: "utf8" }), /package\/dist\/runtime\/contract-manifest\.json/u);
    assert.match(execFileSync("tar", ["-tvzf", path.join(output, "daimon.tgz")], { encoding: "utf8" }), /-rwxr-xr-x[^\n]*package\/dist\/runtime\/native\/daimon-engine-broker/u);
    const packedBroker = execFileSync("tar", ["-xOf", path.join(output, "daimon.tgz"), "package/dist/runtime/native/daimon-engine-broker"]);
    assert.equal(`sha256:${createHash("sha256").update(packedBroker).digest("hex")}`, "sha256:e3fe2738fc8a979861085b4003bf2d5d7c284874897cb6ec2e2e2383211768bd");
    const packageContext = path.join(temporary, "package-context"), probe = path.join(temporary, "probe"); mkdirSync(packageContext); mkdirSync(probe);
    cpSync(path.join(output, "daimon.tgz"), path.join(packageContext, "daimon.tgz")); cpSync(path.join(output, "runtime-dependencies.tar"), path.join(packageContext, "dependencies.tar")); cpSync(path.join(output, "source-inputs.json"), path.join(packageContext, "source-inputs.json"));
    execFileSync("docker", ["build", "--network=none", "--platform", "linux/amd64", "--target", "offline_dependency_probe", "--build-context", `daimon_package=${packageContext}`,
      "--output", `type=local,dest=${probe}`, "--build-arg", `DAIMON_PACKAGE_SHA256=${digest(path.join(output, "daimon.tgz"))}`,
      "--build-arg", `DAIMON_DEPENDENCY_ARCHIVE_SHA256=${digest(path.join(output, "runtime-dependencies.tar"))}`, "-f", path.join(repository, "runtime-images", "daimon", "Dockerfile"), repository], { stdio: "inherit" });
    assert.deepEqual(JSON.parse(readFileSync(path.join(probe, "probe", "source-inputs.json"), "utf8")), identity);
    const grok = path.join(packageContext, "grok"), agyTree = path.join(temporary, "agy-tree"), agy = path.join(agyTree, "antigravity"), agyTar = path.join(packageContext, "agy.tar.gz");
    writeFileSync(grok, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); mkdirSync(agyTree); writeFileSync(agy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    execFileSync("tar", ["-czf", agyTar, "-C", agyTree, "antigravity"]);
    const runtimeArchive = digest(path.join(output, "runtime-dependencies.tar"));
    const sourceInputs = { dependencies: { archive_sha256: dependencyReceipt.archive_sha256, manifest_sha256: dependencyReceipt.manifest_sha256, package_lock_sha256: dependencyReceipt.manifest.dependency_lock.package_lock_sha256, runtime_archive_sha256: runtimeArchive }, mode: "source-bundle", source: { archive_sha256: sourceReceipt.archive_sha256, manifest_sha256: sourceReceipt.manifest_sha256 }, version: "spawnfile.daimon-source-inputs.v1" };
    writeFileSync(path.join(packageContext, "source-inputs.json"), `${JSON.stringify(sourceInputs)}\n`);
    const manifestBytes = execFileSync("tar", ["-xOf", path.join(output, "daimon.tgz"), "package/dist/runtime/contract-manifest.json"]), manifestSha = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
    const installed = path.join(temporary, "installed"); mkdirSync(installed); execFileSync("tar", ["-xf", path.join(output, "runtime-dependencies.tar"), "-C", installed]);
    const codexSha = digest(path.join(installed, "@openai", "codex", "bin", "codex.js")), grokSha = digest(grok), agySha = digest(agy), packageSha = digest(path.join(output, "daimon.tgz"));
    registry = execFileSync("docker", ["run", "--detach", "--publish", "127.0.0.1::5000", "registry:2"], { encoding: "utf8" }).trim();
    const mapped = execFileSync("docker", ["port", registry, "5000/tcp"], { encoding: "utf8" }).trim().split("\n")[0], port = mapped.slice(mapped.lastIndexOf(":") + 1);
    const identityPath = path.join(repository, ".local-daimon-runtime-identity.json"), priorIdentity = existsSync(identityPath) ? readFileSync(identityPath) : null;
    try {
      execFileSync("npm", ["run", "--silent", "build:local-daimon"], { cwd: repository, env: { ...process.env, AGY_CLI_SHA256: agySha, AGY_CLI_SHA512: sha512(agyTar), AGY_CLI_URL: "https://invalid.example/agy", AGY_CLI_VERSION: "fixture", CODEX_CLI_SHA256: codexSha, GROK_CLI_SHA256: grokSha, GROK_CLI_URL: "https://invalid.example/grok", GROK_CLI_VERSION: "fixture", SPAWNFILE_AGY_CLI_ARCHIVE: agyTar, SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE: dependencyTar, SPAWNFILE_DAIMON_LOCAL_IMAGE_TAG: `127.0.0.1:${port}/noopolis/spawnfile-runtime-daimon:archive-wrapper`, SPAWNFILE_DAIMON_SOURCE_BUNDLE: sourceTar, SPAWNFILE_GROK_CLI_FILE: grok }, stdio: "ignore" });
      const wrapperIdentity = JSON.parse(readFileSync(identityPath, "utf8")); assert.equal(wrapperIdentity.image_architecture, "amd64"); assert.match(wrapperIdentity.image_reference, new RegExp(`^127\\.0\\.0\\.1:${port}/noopolis/spawnfile-runtime-daimon@sha256:[a-f0-9]{64}$`, "u"));
    } finally { if (priorIdentity) writeFileSync(identityPath, priorIdentity); else rmSync(identityPath, { force: true }); }
    const receipt = { architecture: "amd64", daimon: { package_sha256: packageSha, source_inputs: sourceInputs, source_sha256: digest(path.join(packageContext, "source-inputs.json")) }, engines: { agy: { executable_sha256: agySha }, codex: { executable_sha256: codexSha }, grok: { executable_sha256: grokSha } }, manifest_sha256: manifestSha, provenance: { agy: { archive: { format: "tar.gz", sha512: sha512(agyTar), url: "https://invalid.example/agy", version: "fixture" } }, grok: { executable: { sha256: grokSha, url: "https://invalid.example/grok", version: "fixture" } } }, version: "spawnfile.daimon-runtime-capability-receipt.v1" };
    const shipped = path.join(temporary, "shipped"); mkdirSync(shipped);
    execFileSync("docker", ["build", "--network=none", "--platform", "linux/amd64", "--build-context", `daimon_package=${packageContext}`, "--output", `type=local,dest=${shipped}`,
      "--build-arg", `DAIMON_CAPABILITY_RECEIPT_BASE64=${Buffer.from(`${JSON.stringify(receipt)}\n`).toString("base64")}`, "--build-arg", `DAIMON_MANIFEST_SHA256=${manifestSha}`, "--build-arg", `DAIMON_PACKAGE_SHA256=${packageSha}`, "--build-arg", `DAIMON_SOURCE_SHA256=${receipt.daimon.source_sha256}`, "--build-arg", "DAIMON_DEPENDENCY_MODE=offline-bundle", "--build-arg", `DAIMON_DEPENDENCY_ARCHIVE_SHA256=${runtimeArchive}`, "--build-arg", `CODEX_CLI_SHA256=${codexSha}`, "--build-arg", "GROK_CLI_VERSION=fixture", "--build-arg", "GROK_CLI_URL=https://invalid.example/grok", "--build-arg", `GROK_CLI_SHA256=${grokSha.slice(7)}`, "--build-arg", "AGY_CLI_VERSION=fixture", "--build-arg", "AGY_CLI_URL=https://invalid.example/agy", "--build-arg", `AGY_CLI_SHA512=${sha512(agyTar).slice(7)}`, "--build-arg", `AGY_CLI_SHA256=${agySha.slice(7)}`, "-f", path.join(repository, "runtime-images", "daimon", "Dockerfile"), repository], { stdio: "ignore" });
    assert.deepEqual(JSON.parse(readFileSync(path.join(shipped, "opt", "spawnfile", "runtime-installs", "daimon", "source-inputs.json"), "utf8")), receipt.daimon.source_inputs);
    const shippedRoot=path.join(shipped,"opt","spawnfile","runtime-installs","daimon");
    assert.equal(digest(path.join(shippedRoot,"bin","daimon-engine-broker")),"sha256:e3fe2738fc8a979861085b4003bf2d5d7c284874897cb6ec2e2e2383211768bd");
    assert.equal(readFileSync(path.join(shippedRoot,"contract-manifest.sha256"),"utf8"),`${manifestSha}\n`);
    const orgContext = path.join(temporary, "literal-org-context"), orgTag = `spawnfile-literal-org-${Date.now().toString(36)}`;
    mkdirSync(orgContext);
    writeFileSync(path.join(orgContext, "materialize.cjs"), renderRuntimeLinkMaterializer());
    writeFileSync(path.join(orgContext, "entrypoint.sh"), [
      "#!/usr/bin/env bash", "set -euo pipefail",
      "export HOME=/tmp XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache",
      "root=/opt/spawnfile/runtime-installs/daimon",
      "test ! -L \"$root/bin/daimon-runtime\"",
      "test ! -L \"$root/bin/codex\"",
      "test \"$(stat -c '%u:%g:%a' \"$root/bin/daimon-runtime\")\" = 0:0:555",
      "test \"$(stat -c '%u:%g:%a' \"$root/bin/codex\")\" = 0:0:555",
      "! ls \"$root\" >/dev/null 2>&1",
      "! test -w \"$root/bin/daimon-runtime\"",
      "output=\"$(\"$root/bin/daimon-runtime\" 2>&1 || true)\"",
      "grep -q 'usage: daimon-runtime' <<<\"$output\"",
      "printf 'literal-runtime-ok uid=%s\\n' \"$(id -u)\""
    ].join("\n") + "\n", { mode: 0o755 });
    writeFileSync(path.join(orgContext, "Dockerfile"), [
      "FROM runtime_artifact AS runtime_artifact",
      "FROM node:24-bookworm-slim",
      "COPY --from=runtime_artifact /opt/spawnfile/runtime-installs/daimon /opt/spawnfile/runtime-installs/daimon",
      "COPY materialize.cjs /opt/spawnfile/materialize-runtime-links.cjs",
      "COPY --chmod=755 entrypoint.sh /entrypoint.sh",
      "RUN node /opt/spawnfile/materialize-runtime-links.cjs /opt/spawnfile/runtime-installs/daimon && rm /opt/spawnfile/materialize-runtime-links.cjs && test -z \"$(find -P /opt/spawnfile/runtime-installs/daimon -type l -print -quit)\" && chmod 711 /opt /opt/spawnfile /opt/spawnfile/runtime-installs && find -P /opt/spawnfile/runtime-installs/daimon -type d -exec chmod 711 {} + && find -P /opt/spawnfile/runtime-installs/daimon -type f -perm /111 -exec chmod 555 {} + && find -P /opt/spawnfile/runtime-installs/daimon -type f ! -perm /111 -exec chmod 444 {} + && useradd --uid 2000 --no-create-home runtime",
      "USER 2000:2000", "ENTRYPOINT [\"/entrypoint.sh\"]"
    ].join("\n") + "\n");
    execFileSync("docker", ["build", "--network=none", "--platform", "linux/amd64", "--build-context", `runtime_artifact=${shipped}`, "--tag", orgTag, orgContext], { stdio: "ignore" });
    const orgContainer = `${orgTag}-container`;
    try {
      execFileSync("docker", ["create", "--name", orgContainer, orgTag], { stdio: "ignore" });
      assert.match(execFileSync("docker", ["start", "--attach", orgContainer], { encoding: "utf8" }), /literal-runtime-ok uid=2000/u);
      assert.match(execFileSync("docker", ["start", "--attach", orgContainer], { encoding: "utf8" }), /literal-runtime-ok uid=2000/u);
    } finally {
      spawnSync("docker", ["rm", "--force", orgContainer], { stdio: "ignore" });
      spawnSync("docker", ["image", "rm", "--force", orgTag], { stdio: "ignore" });
    }
    const falseLockPath = path.join(closure, "package-lock.json"), falseLock = JSON.parse(readFileSync(falseLockPath, "utf8"));
    falseLock.packages["node_modules/@openai/codex"].integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    writeFileSync(falseLockPath, JSON.stringify(falseLock));
    const fakeTar = path.join(temporary, "fake-dependencies.tar"), fakeContext = path.join(temporary, "fake-context"), fakeOutput = path.join(temporary, "fake-output");
    execFileSync("npm", ["run", "--silent", "bundle:source-provenance", "--", "--dependencies", closure, fakeTar], { cwd: repository, stdio: "ignore" });
    const fakeReceipt = validateSourceBundle(readFileSync(fakeTar));
    mkdirSync(fakeContext); mkdirSync(fakeOutput); cpSync(fakeTar, path.join(fakeContext, "dependencies.tar"));
    const fakeArgs = args.map((value) => value === `dependency_bundle=${dependencyContext}` ? `dependency_bundle=${fakeContext}` : value === `DEPENDENCY_ARCHIVE_SHA256=${dependencyReceipt.archive_sha256}` ? `DEPENDENCY_ARCHIVE_SHA256=${fakeReceipt.archive_sha256}` : value === `DEPENDENCY_MANIFEST_SHA256=${dependencyReceipt.manifest_sha256}` ? `DEPENDENCY_MANIFEST_SHA256=${fakeReceipt.manifest_sha256}` : value === `type=local,dest=${output}` ? `type=local,dest=${fakeOutput}` : value);
    assert.notEqual(spawnSync("docker", fakeArgs, { stdio: "ignore" }).status, 0);
    for (const fault of ["missing", "wrong"]) {
      const badRoot=path.join(temporary,`bad-native-${fault}`),badTar=path.join(temporary,`bad-native-${fault}.tar`),badContext=path.join(temporary,`bad-native-${fault}-context`),badOutput=path.join(temporary,`bad-native-${fault}-output`);
      mkdirSync(badRoot);execFileSync("tar",["-xf",sourceTar,"-C",badRoot]);rmSync(path.join(badRoot,".spawnfile-source-manifest.json"),{force:true});const artifact=path.join(badRoot,"src","runtime","native","artifacts","daimon-engine-broker-x64");if(fault==="missing")rmSync(artifact);else writeFileSync(artifact,"wrong-native-artifact\n",{mode:0o755});
      const badReceipt=createSourceBundle(badRoot,badTar);mkdirSync(badContext);mkdirSync(badOutput);cpSync(badTar,path.join(badContext,"source.tar"));const badArgs=args.map((value)=>value===`source_bundle=${sourceContext}`?`source_bundle=${badContext}`:value===`SOURCE_ARCHIVE_SHA256=${sourceReceipt.archive_sha256}`?`SOURCE_ARCHIVE_SHA256=${badReceipt.archive_sha256}`:value===`SOURCE_MANIFEST_SHA256=${sourceReceipt.manifest_sha256}`?`SOURCE_MANIFEST_SHA256=${badReceipt.manifest_sha256}`:value===`type=local,dest=${output}`?`type=local,dest=${badOutput}`:value);assert.notEqual(spawnSync("docker",badArgs,{stdio:"ignore"}).status,0);
    }
    const tampered = readFileSync(path.join(dependencyContext, "dependencies.tar")); tampered[tampered.length - 1025] ^= 1; writeFileSync(path.join(dependencyContext, "dependencies.tar"), tampered);
    assert.notEqual(spawnSync("docker", args, { stdio: "ignore" }).status, 0);
  } finally { if (registry) spawnSync("docker", ["rm", "--force", registry], { stdio: "ignore" }); rmSync(temporary, { force: true, recursive: true }); }
});
