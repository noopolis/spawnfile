import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { parseContainerBundleArchive, validateContainerBundleEnvelope } from "./containerBundleArchive.js";
import { parseTargetLocalBundlePrepareRequest } from "./containerBundleContracts.js";

const BLOCK = 512;
const octal = (value: number, width: number): Buffer => Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
const checksum = (header: Buffer): void => {
  header.fill(0x20, 148, 156); let sum = 0; for (const byte of header) sum += byte;
  header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
};
const alternateChecksum = (header: Buffer): void => {
  header.fill(0x20, 148, 156); let sum = 0; for (const byte of header) sum += byte;
  header.set(octal(sum, 8), 148);
};
const archive = (entries: readonly { readonly bytes: string; readonly path: string }[]): Uint8Array => {
  const output: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK); const split = entry.path.length <= 100 ? -1 : entry.path.lastIndexOf("/");
    header.set(Buffer.from(split < 0 ? entry.path : entry.path.slice(split + 1))); if (split >= 0) header.set(Buffer.from(entry.path.slice(0, split)), 345);
    const bytes = Buffer.from(entry.bytes); header.set(octal(0o644, 8), 100); header.set(octal(0, 8), 108); header.set(octal(0, 8), 116);
    header.set(octal(bytes.byteLength, 12), 124); header.set(octal(0, 12), 136); header[156] = 48;
    header.set(Buffer.from("ustar\0", "ascii"), 257); header.set(Buffer.from("00", "ascii"), 263); checksum(header);
    output.push(header, bytes, Buffer.alloc((BLOCK - bytes.byteLength % BLOCK) % BLOCK));
  }
  output.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)); return Buffer.concat(output);
};
const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("container bundle canonical archive", () => {
  it("accepts canonical sorted USTAR including a canonical prefix", () => {
    const long = `${"z".repeat(101)}/entry.mjs`;
    const bytes = archive([{ path: "bundle.json", bytes: "{}" }, { path: long, bytes: "export {}" }]);
    expect(parseContainerBundleArchive(bytes, ["bundle.json", long], digest(bytes)).entries.map((entry) => entry.path))
      .toEqual(["bundle.json", long]);
  });

  it("accepts the alternate exact seven-digit NUL-terminated USTAR checksum field", () => {
    const bytes = Buffer.from(archive([{ path: "bundle.json", bytes: "{}" }]));
    alternateChecksum(bytes.subarray(0, BLOCK));
    expect(parseContainerBundleArchive(bytes, ["bundle.json"], digest(bytes)).entries).toHaveLength(1);
  });

  it("rejects noncanonical header fields, device fields, and archive order", () => {
    const bytes = Buffer.from(archive([{ path: "bundle.json", bytes: "{}" }, { path: "z.mjs", bytes: "x" }]));
    bytes[329] = 1;
    expect(() => parseContainerBundleArchive(bytes, ["bundle.json", "z.mjs"], digest(bytes))).toThrow("Container bundle archive failed");
    const ordered = archive([{ path: "bundle.json", bytes: "{}" }, { path: "z.mjs", bytes: "x" }]);
    expect(() => parseContainerBundleArchive(ordered, ["z.mjs", "bundle.json"], digest(ordered))).toThrow("Container bundle archive failed");
  });

  it("rejects noncanonical base64 and provider identity fields from the public request", () => {
    const request = {
      archive_base64: "YQ==", archive_digest: `sha256:${"a".repeat(64)}`, archive_entries: ["bundle.json"],
      artifact_digest: `sha256:${"b".repeat(64)}`, build_policy_digest: `sha256:${"c".repeat(64)}`,
      bundle_digest: `sha256:${"d".repeat(64)}`, entrypoint: "bundle.json", idempotency_key: "idem_abcdefghijklmnop",
      launcher_digest: `sha256:${"e".repeat(64)}`, network_alias: "world", platform: { architecture: "amd64", os: "linux" },
      platform_digest: `sha256:${"f".repeat(64)}`, selected_target: { fingerprint: `sha256:${"1".repeat(32)}`, handle: `opaque_${"a".repeat(32)}` },
      version: "spawnfile.target-local-container-bundle.prepare-request.v1"
    };
    expect(parseTargetLocalBundlePrepareRequest(request)).toMatchObject({ archive_base64: "YQ==" });
    expect(parseTargetLocalBundlePrepareRequest({
      ...request, archive_entries: ["runtime/runner.mjs"], entrypoint: "runtime/runner.mjs"
    })).toMatchObject({ archive_entries: ["runtime/runner.mjs"] });
    expect(() => parseTargetLocalBundlePrepareRequest({ ...request, archive_base64: "YQ" })).toThrow();
    expect(() => parseTargetLocalBundlePrepareRequest({ ...request, daemon_epoch: `sha256:${"0".repeat(64)}` })).toThrow();
    expect(() => parseTargetLocalBundlePrepareRequest({ ...request, base_image_config_digest: `sha256:${"0".repeat(64)}` })).toThrow();
  });

  it("admits a provider-opaque sealed envelope bound only to immutable deployment roles", () => {
    const artifact = Buffer.from("artifact"); const launcher = Buffer.from("launcher");
    const claims = {
      artifact_digest: `sha256:${"a".repeat(64)}`, build_policy_digest: `sha256:${"b".repeat(64)}`,
      bundle_digest: `sha256:${"c".repeat(64)}`, entrypoint: "runtime/runner.mjs",
      launcher_digest: digest(launcher), network_alias: "world",
      platform: { architecture: "amd64" as const, os: "linux" as const }, platform_digest: `sha256:${"d".repeat(64)}`
    };
    const bytes = archive([{ path: "bundle.json", bytes: "{\"provider\":\"opaque\"}" }, { path: "runtime/main.mjs", bytes: artifact.toString("utf8") }, { path: claims.entrypoint, bytes: launcher.toString("utf8") }]);
    const parsed = parseContainerBundleArchive(bytes, ["bundle.json", "runtime/main.mjs", claims.entrypoint], digest(bytes));
    expect(() => validateContainerBundleEnvelope(parsed, claims)).not.toThrow();
    expect(() => validateContainerBundleEnvelope(parsed, { ...claims, artifact_digest: claims.launcher_digest })).toThrow("Container bundle archive failed");
    expect(() => validateContainerBundleEnvelope(parsed, { ...claims, launcher_digest: claims.artifact_digest })).toThrow("Container bundle archive failed");
    const providerChanged = archive([{ path: "bundle.json", bytes: "{\"anything\":[1,2,3]}" }, { path: "runtime/main.mjs", bytes: artifact.toString("utf8") }, { path: claims.entrypoint, bytes: launcher.toString("utf8") }]);
    expect(() => validateContainerBundleEnvelope(
      parseContainerBundleArchive(providerChanged, ["bundle.json", "runtime/main.mjs", claims.entrypoint], digest(providerChanged)),
      claims
    )).not.toThrow();
  });

  it("ratchets generic target deployment against provider-private vocabulary", () => {
    const forbidden = [
      ["sim", "file"].join(""),
      ["world", "-", "artifact"].join(""),
      ["tiny", "football"].join(""),
      ["/run/", "sim", "file", "/", "evidence"].join(""),
      ["40", "70"].join(""),
      ["199", "71"].join("")
    ];
    const directory = new URL(".", import.meta.url);
    const sources = readdirSync(directory)
      .filter((name) => /\.ts$/u.test(name))
      .map((name) => readFileSync(new URL(name, directory), "utf8").toLowerCase())
      .concat(readFileSync(new URL("../cli/lifecycleCommands.ts", directory), "utf8").toLowerCase())
      .join("\n");
    for (const term of forbidden) expect(sources).not.toContain(term);
  });

  it("enforces the generic target deployment module boundary from parsed imports", () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const modules = readdirSync(directory).filter((name) =>
      /^(?:containerBundle|dockerContainerBundle|dockerPreparedArtifact|dockerWorldService).*\.ts$/u.test(name)
      && !name.endsWith(".test.ts"));
    for (const name of modules) {
      const source = readFileSync(path.join(directory, name), "utf8");
      for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
        const specifier = imported.fileName;
        const allowed = specifier.startsWith("node:") || specifier === "zod"
          || specifier === "../shared/index.js" || specifier.startsWith("./");
        expect(allowed, `${name} imports forbidden module ${specifier}`).toBe(true);
        if (specifier.startsWith("./")) {
          const resolved = path.resolve(directory, specifier);
          expect(resolved.startsWith(`${directory}${path.sep}`), `${name} escapes target boundary`).toBe(true);
        }
      }
    }
  });
});
