import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "../../../runtime/daimon/contractManifest.js";
import type { TrainingImageBuild } from "./contract.js";
import {
  DAIMON_RUNTIME_INSTALL_ROOT,
  bindDaimonParentVerification,
  daimonParentVerificationScript,
  resolveTrainingDaimonParent
} from "./daimonParent.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const manifestDigest = digest("native-parent-manifest");
const registry = "127.0.0.1:5000";
const NATIVE_IMAGE = `${registry}/paideia/native-training@${digest("native-training-image")}`;
const DECLARATION = "/declared/training-declaration/launch.json";
/** The real recipe's native stage header; the guard must land immediately after it. */
const RECIPE = "ARG NATIVE_IMAGE\nARG PYTHON_IMAGE\nFROM ${PYTHON_IMAGE} AS python\nFROM ${NATIVE_IMAGE} AS training\nCOPY --from=python /usr/local /opt/python\n";

const build = (patch: Partial<TrainingImageBuild> = {}): TrainingImageBuild => ({
  recipe: "daimon-dspy.v1", nativeImage: NATIVE_IMAGE, pythonImage: digest("python"), platform: "linux/arm64",
  paideia: "paideia", bridge: "bridge", claude: "claude",
  integration: { source: "integration", entry: "entry.ts" }, ...patch
} as TrainingImageBuild);

const identityFile = async (patch: Record<string, unknown> = {}): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-identity-"));
  roots.push(directory);
  const identityPath = path.join(directory, "runtime-identity.json");
  await writeFile(identityPath, `${JSON.stringify({
    capability_receipt_sha256: digest("current-capability-receipt"),
    development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    image_architecture: "arm64", image_config_digest: manifestDigest, image_manifest_digest: manifestDigest,
    image_reference: `${registry}/noopolis/spawnfile-runtime-daimon@${manifestDigest}`,
    manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256, registry_authority: registry,
    version: "spawnfile.local-daimon-runtime-identity.v3", ...patch
  })}\n`, { mode: 0o600 });
  return identityPath;
};

/** A stand-in for the Daimon install a native parent copies out of the scratch runtime image. */
const nativeParentInstall = async (receiptContent: string, manifestSha: string = DAIMON_CONTRACT_MANIFEST_SHA256): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-native-parent-"));
  roots.push(root);
  const installRoot = path.join(root, DAIMON_RUNTIME_INSTALL_ROOT);
  await mkdir(installRoot, { recursive: true });
  await writeFile(path.join(installRoot, "capability-receipt.json"), receiptContent);
  await writeFile(path.join(installRoot, "contract-manifest.sha256"), manifestSha);
  return root;
};

/** Executes the generated guard with the image's install root rebased onto a local tree. */
const verify = async (script: string, parentRoot: string): Promise<{ code: number; stderr: string }> => {
  const rebased = script.replaceAll(`'${DAIMON_RUNTIME_INSTALL_ROOT}/`, `'${path.join(parentRoot, DAIMON_RUNTIME_INSTALL_ROOT)}/`);
  try {
    const { stderr } = await run("/bin/sh", ["-c", rebased]);
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
};

const parentFor = async (identityPath: string, patch?: Partial<TrainingImageBuild>) => {
  const parent = await resolveTrainingDaimonParent(build(patch), DECLARATION,
    { SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY: identityPath });
  if (!parent) throw Error("expected a resolved native parent");
  return parent;
};

it("refuses a native parent that does not carry the Daimon install its identity attests, naming both", async () => {
  const parent = await parentFor(await identityFile());
  // The previous rebuild's image: same contract pin, same architecture, different install.
  const stale = await nativeParentInstall(JSON.stringify({ receipt: "previous-rebuild" }));
  const result = await verify(daimonParentVerificationScript(parent), stale);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(DECLARATION);
  expect(result.stderr).toContain(NATIVE_IMAGE);
  expect(result.stderr).toContain(parent.identityPath);
  expect(result.stderr).toContain(digest("current-capability-receipt"));
  expect(result.stderr).toContain(digest(JSON.stringify({ receipt: "previous-rebuild" })));
});

it("runs a matching pair, and refuses a parent whose contract manifest drifted", async () => {
  const parent = await parentFor(await identityFile({ capability_receipt_sha256: digest("matched-receipt") }));
  const matching = await nativeParentInstall("matched-receipt");
  expect(await verify(daimonParentVerificationScript(parent), matching)).toMatchObject({ code: 0 });

  const drifted = await nativeParentInstall("matched-receipt", digest("other-contract-manifest"));
  const result = await verify(daimonParentVerificationScript(parent), drifted);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(DAIMON_CONTRACT_MANIFEST_SHA256);
  expect(result.stderr).toContain(digest("other-contract-manifest"));
});

it("refuses a parent with no Daimon install at all", async () => {
  const parent = await parentFor(await identityFile());
  const empty = await mkdtemp(path.join(os.tmpdir(), "spawnfile-empty-parent-"));
  roots.push(empty);
  const result = await verify(daimonParentVerificationScript(parent), empty);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("not a Daimon native parent");
});

it("keeps the contract-pin refusal and adds architecture agreement", async () => {
  const altered = await identityFile({ manifest_sha256: digest("some-other-contract-manifest") });
  await expect(resolveTrainingDaimonParent(build(), DECLARATION,
    { SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY: altered })).rejects.toThrow(/invalid or incomplete/u);

  const identityPath = await identityFile();
  await expect(resolveTrainingDaimonParent(build({ platform: "linux/amd64" }), DECLARATION,
    { SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY: identityPath })).rejects.toThrow(/linux\/amd64[\s\S]*arm64/u);
});

it("requires an identity for a locally built native parent and leaves a published one alone", async () => {
  await expect(resolveTrainingDaimonParent(build(), DECLARATION, {}))
    .rejects.toThrow(/no attested Daimon runtime identity/u);
  await expect(resolveTrainingDaimonParent(build({ nativeImage: digest("published-parent") }), DECLARATION, {}))
    .resolves.toBeUndefined();
});

it("injects the guard as the first instruction of the native stage and refuses a recipe without one", async () => {
  const parent = await parentFor(await identityFile());
  const bound = bindDaimonParentVerification(RECIPE, parent);
  const lines = bound.split("\n");
  expect(lines[lines.indexOf("FROM ${NATIVE_IMAGE} AS training") + 1]).toBe(`RUN ${daimonParentVerificationScript(parent)}`);
  expect(() => bindDaimonParentVerification("FROM scratch\n", parent)).toThrow(/no \$\{NATIVE_IMAGE\} stage/u);
});

it("refuses to embed a path it cannot quote inertly", async () => {
  const identityPath = await identityFile();
  await expect(resolveTrainingDaimonParent(build(), "/declared/'; rm -rf /; '/launch.json",
    { SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY: identityPath })).rejects.toThrow(/cannot be embedded/u);
});
