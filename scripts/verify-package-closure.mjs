#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const packageManifestPath = path.join(packageRoot, "package.json");
const lockPath = path.join(packageRoot, "package-lock.json");
const STELE = "@noopolis/stele";
const STELE_VERSION = "0.0.2";

const fail = (message) => {
  throw new Error(message);
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const run = (command, args, cwd, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) {
      reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr}`));
      return;
    }
    resolve({ stderr, stdout });
  });
});

const parseSinglePack = (stdout) => {
  let parsed;
  for (let index = stdout.lastIndexOf("["); index >= 0; index = stdout.lastIndexOf("[", index - 1)) {
    try {
      const candidate = JSON.parse(stdout.slice(index));
      if (Array.isArray(candidate)) {
        parsed = candidate;
        break;
      }
    } catch {
      // Lifecycle scripts may write to stdout before npm's final JSON array.
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) fail("npm pack must report exactly one tarball");
  const [result] = parsed;
  if (!result || typeof result.filename !== "string" || !Array.isArray(result.files)) {
    fail("npm pack returned an invalid manifest");
  }
  return result;
};

const assertSourceClosure = async (manifest, lock) => {
  if (manifest.dependencies?.[STELE] !== STELE_VERSION) {
    fail(`${STELE} must use the published ${STELE_VERSION} release coordinate`);
  }
  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies;
  if (bundled !== undefined) fail("published registry dependencies must not be bundled");
  const locked = lock.packages?.[`node_modules/${STELE}`];
  if (!locked || locked.link === true || locked.version !== STELE_VERSION) {
    fail(`${STELE} lock entry must be a physical, version-matched registry package`);
  }
  const expectedTarball = `https://registry.npmjs.org/@noopolis/stele/-/stele-${STELE_VERSION}.tgz`;
  if (locked.resolved !== expectedTarball) {
    fail(`${STELE} must resolve from the npm registry, got ${String(locked.resolved)}`);
  }
  if (typeof locked.integrity !== "string" || !locked.integrity.startsWith("sha512-")) {
    fail(`${STELE} registry lock is missing sha512 integrity`);
  }
  const installed = path.join(packageRoot, "node_modules", STELE);
  if ((await lstat(installed)).isSymbolicLink()) {
    fail(`${STELE} must be physically installed before packing; source-checkout links are rejected`);
  }
  const installedManifest = await readJson(path.join(installed, "package.json"));
  if (installedManifest.version !== STELE_VERSION) fail(`${STELE} installed version drifted`);
  return locked.resolved;
};

const assertPackedManifest = (manifest) => {
  if (manifest.dependencies?.[STELE] !== STELE_VERSION) {
    fail(`packed ${STELE} coordinate drifted from ${STELE_VERSION}`);
  }
  if (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) {
    fail("packed manifest unexpectedly bundles registry dependencies");
  }
  for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof value === "string" && value.startsWith("file:")) {
      fail(`packed runtime dependency ${name} retains a checkout-relative file coordinate`);
    }
  }
};

const dependencyRoot = async (installRoot, installedRoot) => {
  const candidates = [
    path.join(installedRoot, "node_modules", STELE),
    path.join(installRoot, "node_modules", STELE),
  ];
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  fail(`${STELE} was not installed from the packed Spawnfile dependency graph`);
};

const assertInstalledClosure = async (installRoot, manifest, tarballPath) => {
  await writeFile(path.join(installRoot, "package.json"), "{\"private\":true}\n", "utf8");
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    "--registry=https://registry.npmjs.org", tarballPath,
  ], installRoot);
  const installedRoot = path.join(installRoot, "node_modules", manifest.name);
  if ((await lstat(installedRoot)).isSymbolicLink()) fail(`${manifest.name} installed as a source link`);
  const moltnetBinaries = await import(pathToFileURL(path.join(
    installedRoot,
    "dist/compiler/moltnetBinaries.js",
  )).href);
  const expectedMoltnetExports = [
    "MOLTNET_BINARY_NAMES", "MOLTNET_BIN_DIRECTORY", "MOLTNET_RELEASE_DIR_ENV",
    "MOLTNET_RELEASE_IDENTITY_VERSION", "MOLTNET_RELEASE_STAMP_VERSION",
    "resolveMoltnetCliCommand", "stageMoltnetBinaries",
  ];
  const actualMoltnetExports = Object.keys(moltnetBinaries).sort();
  if (JSON.stringify(actualMoltnetExports) !== JSON.stringify(expectedMoltnetExports)) {
    fail(`packed compiler Moltnet staging exports drifted: ${actualMoltnetExports.join(", ")}`);
  }
  const moltnetReleases = await Promise.all(["amd64", "arm64"].map(async (architecture) => {
    const outputDirectory = path.join(installRoot, `moltnet-${architecture}`);
    const identity = await moltnetBinaries.stageMoltnetBinaries(outputDirectory, { architecture });
    const binaryPath = path.join(outputDirectory, "moltnet-bin", "moltnet");
    const [binary, metadata] = await Promise.all([readFile(binaryPath), stat(binaryPath)]);
    if (binary.subarray(0, 4).toString("hex") !== "7f454c46" || !(metadata.mode & 0o111)) {
      fail(`packed compiler did not stage an executable Linux ${architecture} Moltnet binary`);
    }
    return identity;
  }));
  const steleRoot = await dependencyRoot(installRoot, installedRoot);
  if ((await lstat(steleRoot)).isSymbolicLink()) fail(`${STELE} installed as a source link`);
  const steleManifest = await readJson(path.join(steleRoot, "package.json"));
  if (steleManifest.version !== STELE_VERSION) fail(`${STELE} installed version drifted`);
  const steleImport = steleManifest.exports?.["."]?.import;
  if (typeof steleImport !== "string" || !steleImport.startsWith("./")) {
    fail(`${STELE} does not expose a package-relative ESM entrypoint`);
  }
  const installRealRoot = await realpath(installRoot);
  const steleRealPath = await realpath(path.resolve(steleRoot, steleImport));
  if (!steleRealPath.startsWith(`${installRealRoot}${path.sep}`)) {
    fail(`${STELE} resolved outside the isolated install`);
  }
  const stele = await import(pathToFileURL(steleRealPath).href);
  if (typeof stele.parseCausalJsonl !== "function") fail(`${STELE} runtime import is incomplete`);
  const executable = path.join(installRoot, "node_modules", ".bin", Object.keys(manifest.bin ?? {})[0]);
  await run(executable, ["--help"], installRoot, {
    ...process.env,
    PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  return {
    moltnetReleases,
    steleResolved: path.relative(installRealRoot, steleRealPath),
  };
};

const main = async () => {
  const manifest = await readJson(packageManifestPath);
  const lock = await readJson(lockPath);
  const steleRegistryTarball = await assertSourceClosure(manifest, lock);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `${manifest.name.replaceAll("/", "-")}-closure-`));
  try {
    const packDirectory = path.join(temporaryRoot, "pack");
    const installRoot = path.join(temporaryRoot, "install");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installRoot, { recursive: true }),
    ]);
    const packed = parseSinglePack((await run(
      "npm", ["pack", "--json", "--pack-destination", packDirectory], packageRoot,
    )).stdout);
    const tarballPath = path.join(packDirectory, packed.filename);
    const packedBytes = await readFile(tarballPath);
    const packedIntegrity = `sha512-${createHash("sha512").update(packedBytes).digest("base64")}`;
    const packedShasum = createHash("sha1").update(packedBytes).digest("hex");
    if (packed.integrity !== packedIntegrity || packed.shasum !== packedShasum) {
      fail("npm pack manifest integrity does not match the inspected tarball bytes");
    }
    const entries = new Set(packed.files.map((entry) => entry.path));
    if ((packed.bundled?.length ?? 0) !== 0) fail("npm pack unexpectedly bundled dependencies");
    if ([...entries].some((entry) => entry.startsWith("node_modules/")
      || entry.includes("ecosystem/") || /vendor\/.*\.tgz$/u.test(entry))) {
      fail("packed tarball leaked dependencies, a source checkout, or a vendor archive");
    }
    const packedManifest = JSON.parse((await run(
      "tar", ["-xOf", tarballPath, "package/package.json"], packageRoot,
    )).stdout);
    assertPackedManifest(packedManifest);
    const installed = await assertInstalledClosure(installRoot, manifest, tarballPath);
    process.stdout.write(`${JSON.stringify({
      bundled: packed.bundled ?? [],
      entries: packed.entryCount,
      integrity: packed.integrity,
      package: packed.id,
      packed_file: packed.filename,
      moltnet_releases: installed.moltnetReleases,
      runtime_dependencies: packedManifest.dependencies,
      stele_registry_tarball: steleRegistryTarball,
      stele_resolved_inside_install: installed.steleResolved,
    }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

await main();
