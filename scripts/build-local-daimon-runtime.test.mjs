import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalDaimonCapabilityReceipt,
  readDaimonCliArtifactPins,
  resolveDaimonSourceMode,
  resolveLocalBuildArchitecture,
  resolveLocalImageTag,
  resolvePushedImageReference
} from "./build-local-daimon-runtime.mjs";
import { collectSourceManifest, createSourceBundle, validateSourceBundle } from "./source-provenance-bundle.mjs";

const digest = (character, length = 64) => character.repeat(length);
const artifactEnvironment = () => ({
  AGY_CLI_SHA256: digest("a"),
  AGY_CLI_SHA512: digest("b", 128),
  AGY_CLI_URL: "https://example.invalid/agy/antigravity-linux-amd64.tar.gz",
  AGY_CLI_VERSION: "1.2.3",
  CODEX_CLI_SHA256: digest("c"),
  GROK_CLI_SHA256: digest("d"),
  GROK_CLI_URL: "https://example.invalid/grok/grok-linux-amd64",
  GROK_CLI_VERSION: "0.9.0"
});

test("local Daimon receipt binds engine executables and credential-free artifact provenance", () => {
  const artifacts = readDaimonCliArtifactPins(artifactEnvironment());
  const receipt = createLocalDaimonCapabilityReceipt({
    architecture: "amd64",
    artifacts,
    manifestSha256: `sha256:${digest("e")}`,
    packageSha256: `sha256:${digest("f")}`,
    sourceSha256: `sha256:${digest("0")}`
  });

  assert.deepEqual(Object.keys(receipt.engines).sort(), ["agy", "codex", "grok"]);
  assert.equal(receipt.engines.agy.executable_sha256, `sha256:${digest("a")}`);
  assert.deepEqual(receipt.provenance.agy.archive, {
    format: "tar.gz",
    sha512: `sha512:${digest("b", 128)}`,
    url: "https://example.invalid/agy/antigravity-linux-amd64.tar.gz",
    version: "1.2.3"
  });
  assert.deepEqual(receipt.provenance.grok.executable, {
    sha256: `sha256:${digest("d")}`,
    url: "https://example.invalid/grok/grok-linux-amd64",
    version: "0.9.0"
  });
  assert.equal(receipt.provenance.mode, "local-development");
});

test("artifact pins reject missing AGY archive SHA-512", () => {
  const env = artifactEnvironment();
  delete env.AGY_CLI_SHA512;
  assert.throws(() => readDaimonCliArtifactPins(env), /AGY_CLI_SHA512/u);
});

test("artifact pins reject credential-bearing URLs without disclosing credentials", () => {
  const env = artifactEnvironment();
  env.AGY_CLI_URL = "https://user:super-secret@example.invalid/agy.tar.gz";

  let message = "";
  assert.throws(() => readDaimonCliArtifactPins(env), (error) => {
    message = error.message;
    return /AGY_CLI_URL/u.test(message);
  });
  assert.doesNotMatch(message, /super-secret/u);
});

test("local image authority accepts an ephemeral loopback registry and immutable pushed digest", () => {
  const tag = "127.0.0.1:54321/noopolis/spawnfile-runtime-daimon:0.2.0-local";
  const immutable = `127.0.0.1:54321/noopolis/spawnfile-runtime-daimon@sha256:${digest("1")}`;

  assert.equal(resolveLocalImageTag(tag), tag);
  assert.equal(resolvePushedImageReference(tag, [immutable]), immutable);
  assert.throws(() => resolveLocalImageTag("127.0.0.1:54321/noopolis/spawnfile-runtime-daimon:latest"), /non-latest/u);
  assert.throws(() => resolveLocalImageTag("registry.invalid/daimon:local"), /127\.0\.0\.1/u);
  assert.throws(() => resolveLocalImageTag("0.0.0.0:54321/noopolis/spawnfile-runtime-daimon:local"), /127\.0\.0\.1/u);
  assert.throws(() => resolvePushedImageReference(tag, []), /manifest digest/u);
});

test("local build architecture fails closed outside the official AGY linux_amd64 target", () => {
  assert.equal(resolveLocalBuildArchitecture("x64"), "amd64");
  assert.equal(resolveLocalBuildArchitecture("arm64"), "amd64");
  assert.throws(() => resolveLocalBuildArchitecture("riscv64"), /linux\/amd64/u);
});

test("archive provenance is explicit and cannot silently fall back to Git", () => {
  assert.equal(resolveDaimonSourceMode({}), "clean-git");
  assert.equal(resolveDaimonSourceMode({ SPAWNFILE_DAIMON_SOURCE_BUNDLE: "/source.tar", SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE: "/deps.tar" }), "source-bundle");
  assert.throws(() => resolveDaimonSourceMode({ SPAWNFILE_DAIMON_SOURCE_BUNDLE: "/source.tar" }), /requires both/u);
});

test("source bundle includes intended tracked and untracked bytes while excluding VCS, secrets, and generated caches", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-bundle-"));
  try {
    mkdirSync(path.join(root, ".git")); mkdirSync(path.join(root, "node_modules")); mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "tracked.ts"), "tracked\n"); writeFileSync(path.join(root, "untracked.ts"), "untracked\n");
    writeFileSync(path.join(root, ".env.production"), "TOKEN=secret\n"); writeFileSync(path.join(root, "node_modules", "cache"), "generated\n");
    symlinkSync("tracked.ts", path.join(root, "src", "alias.ts"));
    const archive = path.join(root, "..", `${path.basename(root)}.tar`), receipt = createSourceBundle(root, archive);
    const verified = validateSourceBundle(readFileSync(archive));
    assert.equal(verified.archive_sha256, receipt.archive_sha256); assert.equal(verified.manifest_sha256, receipt.manifest_sha256);
    assert.deepEqual(verified.manifest.entries.map((entry) => entry.path), ["src", "src/alias.ts", "src/tracked.ts", "untracked.ts"]);
    assert.doesNotMatch(readFileSync(archive).toString("utf8"), /TOKEN=secret|generated\n/u);
  } finally { rmSync(root, { force: true, recursive: true }); rmSync(path.join(root, "..", `${path.basename(root)}.tar`), { force: true }); }
});

test("source bundle rejects traversal and byte drift", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-hostile-"));
  try {
    writeFileSync(path.join(root, "input.ts"), "one\n");
    const manifest = collectSourceManifest(root); writeFileSync(path.join(root, "input.ts"), "two\n");
    assert.notDeepEqual(collectSourceManifest(root), manifest);
    const archive = path.join(root, "..", `${path.basename(root)}.tar`); createSourceBundle(root, archive);
    const bytes = readFileSync(archive); bytes.write("../escape", 0, "utf8");
    assert.throws(() => validateSourceBundle(bytes), /checksum|unsafe/u);
  } finally { rmSync(root, { force: true, recursive: true }); rmSync(path.join(root, "..", `${path.basename(root)}.tar`), { force: true }); }
});

test("source bundle excludes credential stores and rejects credential-shaped content", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-secret-"));
  try {
    mkdirSync(path.join(root, ".ssh")); mkdirSync(path.join(root, ".aws")); mkdirSync(path.join(root, ".docker"));
    writeFileSync(path.join(root, ".npmrc"), "//registry.invalid/:_authToken=actual-secret-value\n");
    writeFileSync(path.join(root, ".ssh", "id_ed25519"), "private\n"); writeFileSync(path.join(root, ".aws", "credentials"), "private\n");
    writeFileSync(path.join(root, ".docker", "config.json"), "private\n"); writeFileSync(path.join(root, "safe.ts"), "export {};\n");
    assert.deepEqual(collectSourceManifest(root).entries.map((entry) => entry.path), ["safe.ts"]);
    writeFileSync(path.join(root, "leak.txt"), `-----BEGIN PRIVATE KEY-----\n${"A".repeat(120)}\n-----END PRIVATE KEY-----\n`);
    assert.throws(() => collectSourceManifest(root), /credential-shaped content/u);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("build-source rejects credential stores without excluding credential-related source files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-build-source-secret-"));
  try {
    for (const name of ["auth.go", "cookies.go", "keyring.go", "session.go", "token.go", "secret.go", "token_file.go"]) writeFileSync(path.join(root, name), "package fixture\n");
    for (const name of ["auth.json", "cookies", "cookies.json", "keyring.yaml", "session", "session.db", "token", "token.txt", "service-token.json", "secret", "deploy-secret.toml", "credentials.json"]) writeFileSync(path.join(root, name), "not archived\n");
    assert.deepEqual(collectSourceManifest(root, "build-source").entries.map((entry) => entry.path), ["auth.go", "cookies.go", "keyring.go", "secret.go", "session.go", "token.go", "token_file.go"]);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("build-source rejects opaque provider and credential-store directory trees", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-build-source-secret-dirs-"));
  try {
    for (const directory of [".codex", ".grok", ".config/gcloud", "gcloud", "credentials", "cookies", "keyrings", "sessions", "tokens", "secrets"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
      writeFileSync(path.join(root, directory, "opaque"), "unrecognizable credential bytes\n");
    }
    mkdirSync(path.join(root, "internal", "auth"), { recursive: true });
    writeFileSync(path.join(root, "internal", "auth", "auth.go"), "package auth\n");
    assert.deepEqual(collectSourceManifest(root, "build-source").entries.map((entry) => entry.path), ["internal", "internal/auth", "internal/auth/auth.go"]);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("source bundle resolves bounded symlink chains and rejects cycles, dangling links, and ancestor escapes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-links-"));
  try {
    writeFileSync(path.join(root, "target"), "ok\n"); symlinkSync("target", path.join(root, "second")); symlinkSync("second", path.join(root, "first"));
    assert.doesNotThrow(() => collectSourceManifest(root));
    symlinkSync("cycle-b", path.join(root, "cycle-a")); symlinkSync("cycle-a", path.join(root, "cycle-b"));
    assert.throws(() => collectSourceManifest(root), /cyclic/u);
    rmSync(path.join(root, "cycle-a")); rmSync(path.join(root, "cycle-b")); symlinkSync("missing", path.join(root, "dangling"));
    assert.throws(() => collectSourceManifest(root), /not an included input/u);
    rmSync(path.join(root, "dangling")); symlinkSync("../outside", path.join(root, "escape"));
    assert.throws(() => collectSourceManifest(root), /escapes its root/u);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("source bundle validates PAX long paths and rejects drift during creation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-pax-")), archive = path.join(root, "..", `${path.basename(root)}.tar`);
  try {
    const directory = path.join(root, "a".repeat(90)); mkdirSync(directory); writeFileSync(path.join(directory, `${"b".repeat(120)}.ts`), "long\n");
    assert.doesNotThrow(() => validateSourceBundle(readFileSync((createSourceBundle(root, archive), archive))));
    writeFileSync(path.join(root, "drift.ts"), "before\n");
    assert.throws(() => createSourceBundle(root, archive, "source", { afterRead: () => writeFileSync(path.join(root, "drift.ts"), "after\n") }), /drifted/u);
  } finally { rmSync(root, { force: true, recursive: true }); rmSync(archive, { force: true }); }
});

test("dependency bundle binds its amd64 lock closure and rejects a hostile tar", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-dependency-bundle-")), archive = path.join(root, "..", `${path.basename(root)}.tar`);
  try {
    mkdirSync(path.join(root, "npm-cache")); writeFileSync(path.join(root, "npm-cache", "content"), "cache\n"); writeFileSync(path.join(root, "package.json"), '{"name":"closure"}\n');
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, name: "closure", packages: { "": {}, "node_modules/@openai/codex": { version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==` }, "node_modules/typescript": { version: "5.0.0", integrity: `sha512-${"B".repeat(86)}==` } } }));
    const verified = validateSourceBundle(readFileSync((createSourceBundle(root, archive, "dependencies"), archive)));
    assert.equal(verified.manifest.dependency_lock.target, "linux/amd64");
    assert.equal(verified.manifest.dependency_lock.packages.length, 2);
    const hostile = readFileSync(archive); hostile.write("../escape", 0, "utf8");
    assert.throws(() => validateSourceBundle(hostile), /checksum|unsafe/u);
  } finally { rmSync(root, { force: true, recursive: true }); rmSync(archive, { force: true }); }
});

test("dependency lock truth rejects near-empty graphs and a fake Codex version", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-dependency-lock-"));
  try {
    mkdirSync(path.join(root, "npm-cache")); writeFileSync(path.join(root, "npm-cache", "content"), "cache"); writeFileSync(path.join(root, "package.json"), '{"name":"closure"}');
    writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    assert.throws(() => collectSourceManifest(root, "dependencies"), /lacks pinned/u);
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@openai/codex": { version: "9.9.9" }, "node_modules/typescript": { version: "5.0.0", integrity: `sha512-${"B".repeat(86)}==` } } }));
    assert.throws(() => collectSourceManifest(root, "dependencies"), /lacks immutable version\/integrity/u);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("Daimon Dockerfile verifies the AGY archive before extracting antigravity and verifies every installed executable", () => {
  const dockerfile = readFileSync(new URL("../runtime-images/daimon/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:[a-f0-9]{64}\nFROM daimon_package AS daimon_package/mu);
  assert.match(dockerfile, /FROM base_\$\{DAIMON_DEPENDENCY_MODE\} AS base/u);
  assert.match(dockerfile, /FROM grok_source_\$\{DAIMON_DEPENDENCY_MODE\} AS grok_cli/u);
  assert.match(dockerfile, /FROM agy_source_\$\{DAIMON_DEPENDENCY_MODE\} AS agy_cli/u);
  assert.match(dockerfile, /FROM daimon_\$\{DAIMON_DEPENDENCY_MODE\} AS build/u);
  const archiveDownload = dockerfile.indexOf('curl -fsSL "${AGY_CLI_URL}" -o /tmp/agy.tar.gz');
  const archiveVerification = dockerfile.indexOf("sha512sum -c -");
  const archiveExtraction = dockerfile.indexOf("tar -xzf /tmp/agy.tar.gz");
  const executableLookup = dockerfile.indexOf("-name antigravity");
  const executableInstall = dockerfile.indexOf('install -m 0755 "${agy_path}"');
  const grokInstall = dockerfile.indexOf("install -m 0755 /tmp/grok");
  const codexInstall = dockerfile.indexOf("npm install --omit=dev --no-fund --no-audit @openai/codex@");
  const daimonCopy = dockerfile.indexOf("COPY --from=daimon_package /daimon.tgz /tmp/daimon.tgz", dockerfile.indexOf("FROM codex_registry AS daimon_registry"));
  const offlineDaimonCopy = dockerfile.indexOf("COPY --from=daimon_package /daimon.tgz /tmp/daimon.tgz", dockerfile.indexOf("FROM codex_offline-bundle AS daimon_offline-bundle"));

  assert.ok(archiveDownload >= 0);
  assert.ok(archiveDownload < archiveVerification);
  assert.ok(archiveVerification < archiveExtraction);
  assert.ok(archiveExtraction < executableLookup);
  assert.ok(executableLookup < executableInstall);
  assert.ok(grokInstall < daimonCopy);
  assert.ok(executableInstall < daimonCopy);
  assert.ok(codexInstall < daimonCopy);
  assert.ok(grokInstall < offlineDaimonCopy);
  assert.ok(executableInstall < offlineDaimonCopy);
  assert.match(dockerfile, /sha256sum \$\{RUNTIME_ROOT\}\/bin\/agy/u);
  assert.match(dockerfile, /sha256sum \$\{RUNTIME_ROOT\}\/bin\/grok/u);
  assert.match(dockerfile, /sha256sum \$\{RUNTIME_ROOT\}\/node_modules\/@openai\/codex\/bin\/codex\.js/u);
  assert.match(dockerfile, /import "\.\.\/node_modules\/@openai\/codex\/bin\/codex\.js"/u);
  assert.match(dockerfile, /import \{ runOrganizationRuntimeCli \} from "\.\.\/node_modules\/@noopolis\/daimon\/dist\/runtime\/cli\.js"/u);
  assert.match(dockerfile, /await runOrganizationRuntimeCli\(process\.argv\.slice\(2\)\)/u);
  assert.match(dockerfile, /fs\.realpathSync\(p\)/u);
  assert.match(dockerfile, /runtime link escape/u);
  assert.match(dockerfile, /if\(raw!==c\(m\)\+"\\n"\|\|/u);
  assert.match(dockerfile, /e=\{codex:/u);
  assert.doesNotMatch(dockerfile, /e=\{agy:/u);
  assert.match(dockerfile, /a\.unlockSourceSlot!=="agy-unlock-secret"/u);
  assert.match(dockerfile, /a\.directoryMode!==448\|\|a\.fileMode!==384\|\|a\.maxUnlockBytes!==4096/u);
  assert.match(dockerfile, /DAIMON_DEPENDENCY_MODE.*offline-bundle/su);
  assert.match(dockerfile, /sha256sum \/tmp\/dependencies\.tar/u);
  assert.match(dockerfile, /source_inputs\?\.dependencies\?\.runtime_archive_sha256/u);
  assert.match(dockerfile, /tar -xf \/tmp\/dependencies\.tar -C \$\{RUNTIME_ROOT\}\/node_modules/u);
  assert.match(dockerfile, /FROM \$\{NODE_BASE_IMAGE\} AS base_offline-bundle/u);
  assert.match(dockerfile, /FROM \$\{NODE_BASE_IMAGE\} AS base_registry/u);
  assert.match(dockerfile, /FROM codex_registry AS daimon_registry/u);
  assert.match(dockerfile, /FROM codex_offline-bundle AS daimon_offline-bundle/u);
  assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.npm,sharing=locked/u);
  assert.doesNotMatch(dockerfile, /npm cache clean/u);
});
