#!/usr/bin/env node
// Builds this checkout's pi-supporting Moltnet CLI for the container's Linux
// target and packages it as `moltnet_linux_<arch>.tar.gz` into the stable
// local release dir `ecosystem/moltnet/dist/release`.
//
// Why this exists: development against an unreleased Moltnet checkout still
// needs a pinned, locally verified artifact. Standard compiles download the
// authority-pinned published release; this opt-in script produces an explicit
// local override and the e2e helper verifies its identity and content.
//
// The resulting dir is consumed by the compiler's existing
// `stageMoltnetBinaries` mechanism via `SPAWNFILE_MOLTNET_RELEASE_DIR`
// (src/compiler/moltnetBinaries.ts) — this script does not reinvent staging,
// it only produces the asset that mechanism expects.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moltnetDir = path.join(repoRoot, "ecosystem", "moltnet");
const releaseDir = path.join(moltnetDir, "dist", "release");
const releaseAuthority = JSON.parse(readFileSync(
  path.join(repoRoot, "moltnet-releases.json"),
  "utf8"
));

const goarchForHost = () => {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "amd64";
    default:
      throw new Error(`Unsupported host architecture for local Moltnet build: ${process.arch}`);
  }
};

// The bridge validator lists supported runtime kinds here; `RuntimePi` is only
// present once the (currently unreleased) pi-bridge delivery commit is in the
// checkout being built. Refuse to stamp a tarball as pi-capable unless its
// own source actually supports it, so a stale pre-pi-bridge checkout can never
// mint a passing stamp.
const sourceSupportsPiBridge = () => {
  const configPath = path.join(moltnetDir, "pkg", "bridgeconfig", "config.go");
  return readFileSync(configPath, "utf8").includes("RuntimePi");
};

const gitDescribe = () => {
  try {
    return execFileSync("git", ["-C", moltnetDir, "describe", "--tags", "--always", "--dirty"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
};

const gitRevision = () => execFileSync(
  "git", ["-C", moltnetDir, "rev-parse", "HEAD"], { encoding: "utf8" }
).trim();

const assertCleanPinnedSource = (version) => {
  if (version === "unknown" || version.endsWith("-dirty")) {
    throw new Error(
      `Moltnet source identity must be an exact clean revision, received ${version}; refusing to mint a release stamp.`
    );
  }
};

const trustedAssetFor = (arch) => {
  const keys = Object.keys(releaseAuthority).sort().join("\0");
  const assets = releaseAuthority.assets;
  if (keys !== ["assets", "capabilities", "release_version", "source_revision", "version"].sort().join("\0")
    || releaseAuthority.version !== "spawnfile.moltnet-release-authority.v1"
    || !Array.isArray(releaseAuthority.capabilities)
    || releaseAuthority.capabilities.length !== 1
    || releaseAuthority.capabilities[0] !== "pi-bridge"
    || !Array.isArray(assets)
    || assets.length !== 2) {
    throw new Error("Trusted Moltnet release authority is invalid");
  }
  const asset = assets.find((candidate) => candidate.architecture === arch);
  if (!asset
    || Object.keys(asset).sort().join("\0") !== ["architecture", "asset", "asset_sha256"].sort().join("\0")
    || asset.asset !== `moltnet_linux_${arch}.tar.gz`
    || typeof asset.asset_sha256 !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(asset.asset_sha256)
    || typeof releaseAuthority.source_revision !== "string"
    || !/^[a-f0-9]{40}$/u.test(releaseAuthority.source_revision)
    || typeof releaseAuthority.release_version !== "string") {
    throw new Error(`Trusted Moltnet release authority has no valid ${arch} asset`);
  }
  return asset;
};

// The build already cross-compiles through GOARCH, so a laptop can stage the
// release its remote target actually needs. The stamp is written per arch, so
// an override can never overwrite another architecture's capability marker.
const goarchForTarget = () => {
  const requested = process.env.MOLTNET_TARGET_GOARCH;
  if (requested === undefined) return goarchForHost();
  if (requested !== "amd64" && requested !== "arm64") {
    throw new Error(`Unsupported MOLTNET_TARGET_GOARCH: ${requested}`);
  }
  return requested;
};

const main = () => {
  const arch = goarchForTarget();
  const assetName = `moltnet_linux_${arch}.tar.gz`;
  const stampName = `moltnet_release_stamp_${arch}.json`;
  const assetPath = path.join(releaseDir, assetName);
  const stampPath = path.join(releaseDir, stampName);
  const trustedAsset = trustedAssetFor(arch);

  if (!sourceSupportsPiBridge()) {
    throw new Error(
      `ecosystem/moltnet checkout does not support the pi bridge (RuntimePi missing from pkg/bridgeconfig/config.go); ` +
        "refusing to stage. Update the moltnet checkout to a revision with pi-bridge delivery first."
    );
  }

  mkdirSync(releaseDir, { recursive: true });

  const version = gitDescribe();
  assertCleanPinnedSource(version);
  const sourceRevision = gitRevision();
  if (version !== releaseAuthority.release_version
    || sourceRevision !== releaseAuthority.source_revision) {
    throw new Error(
      `Moltnet checkout ${version}/${sourceRevision} does not match trusted authority ` +
      `${releaseAuthority.release_version}/${releaseAuthority.source_revision}`
    );
  }
  const writeTrustedStamp = (sha256) => {
    if (`sha256:${sha256}` !== trustedAsset.asset_sha256) {
      throw new Error(
        `Built Moltnet ${assetName} digest sha256:${sha256} does not match trusted authority ${trustedAsset.asset_sha256}`
      );
    }
    const stamp = {
      arch,
      asset: trustedAsset.asset,
      built_at: new Date().toISOString(),
      capabilities: [...releaseAuthority.capabilities],
      pi_bridge: true,
      sha256,
      source_revision: releaseAuthority.source_revision,
      stamp_version: "spawnfile.moltnet-release-stamp.v1",
      version: releaseAuthority.release_version
    };
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  };
  if (existsSync(assetPath)) {
    const existingSha256 = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
    if (`sha256:${existingSha256}` === trustedAsset.asset_sha256) {
      writeTrustedStamp(existingSha256);
      console.log(`Verified existing trusted ${assetPath}`);
      console.log(`Stamped ${stampPath} from moltnet-releases.json (sha256=${existingSha256.slice(0, 12)}…)`);
      return;
    }
  }
  const workDir = mkdtempSync(path.join(os.tmpdir(), "spawnfile-moltnet-build-"));
  try {
    console.log(`Building local pi-supporting Moltnet (local Go, linux/${arch}) from ${moltnetDir}`);
    execFileSync("go", [
      "build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`,
      "-o", path.join(workDir, "moltnet"), "./cmd/moltnet"
    ], {
      cwd: moltnetDir,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOARCH: arch,
        GOOS: "linux",
        GOTOOLCHAIN: "local"
      },
      stdio: "inherit"
    });
    execFileSync("tar", ["-C", workDir, "-czf", assetPath, "moltnet"], { stdio: "inherit" });
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }

  const sha256 = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
  writeTrustedStamp(sha256);

  console.log(`Staged ${assetPath}`);
  console.log(`Stamped ${stampPath} from moltnet-releases.json (version=${version} revision=${sourceRevision.slice(0, 12)} pi_bridge=true sha256=${sha256.slice(0, 12)}…)`);
};

main();
