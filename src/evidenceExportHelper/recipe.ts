import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { EVIDENCE_EXPORT_HELPER_PATH } from "../target/evidenceExportProvider.js";

export const LOCAL_EVIDENCE_HELPER_RECIPE_VERSION =
  "spawnfile.local-evidence-export-helper.recipe.v1" as const;

const BLOCK = 512;
const MAX_SOURCE_BYTES = 65_536;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

const fail = (): never => { throw new Error("Local evidence-export helper recipe failed"); };
const octal = (value: number, width: number): Buffer => {
  const raw = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || raw.length > width - 1) return fail();
  return Buffer.from(`${raw.padStart(width - 1, "0")}\0`, "ascii");
};
const checksum = (header: Buffer): void => {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  if (sum > 0o777777) return fail();
  header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
};
const archive = (
  entries: readonly {
    readonly bytes: Uint8Array;
    readonly mode: 0o444 | 0o555;
    readonly path: string;
  }[],
): Uint8Array => {
  const output: Buffer[] = [];
  for (const entry of [...entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))) {
    const name = Buffer.from(entry.path, "utf8");
    if (name.byteLength < 1 || name.byteLength > 100
      || entry.mode !== 0o444 && entry.mode !== 0o555) return fail();
    const header = Buffer.alloc(BLOCK);
    header.set(name, 0);
    header.set(octal(entry.mode, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(entry.bytes.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header[156] = 48;
    header.set(Buffer.from("ustar\0", "ascii"), 257);
    header.set(Buffer.from("00", "ascii"), 263);
    header.set(octal(0, 8), 329);
    header.set(octal(0, 8), 337);
    checksum(header);
    output.push(header, Buffer.from(entry.bytes));
    const padding = (BLOCK - entry.bytes.byteLength % BLOCK) % BLOCK;
    if (padding > 0) output.push(Buffer.alloc(padding));
  }
  output.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return Buffer.concat(output);
};

const dockerfile = Buffer.from([
  "ARG SPAWNFILE_HELPER_BASE",
  "FROM ${SPAWNFILE_HELPER_BASE} AS runtime",
  "FROM scratch",
  "COPY --from=runtime / /",
  "COPY helperProgram.mjs /bin/spawnfile-export-helper",
  "LABEL spawnfile.target.evidence-export.helper-contract=\"v1\"",
  `ENV PATH=${EVIDENCE_EXPORT_HELPER_PATH}`,
  "USER 65534:65534",
  "ENTRYPOINT [\"/bin/spawnfile-export-helper\"]",
  "CMD []",
  "",
].join("\n"), "utf8");

export interface LocalEvidenceHelperRecipe {
  readonly artifactManifestDigest: `sha256:${string}`;
  readonly context: Uint8Array;
  readonly recipeDigest: `sha256:${string}`;
}

const digest = (domain: string, bytes: Uint8Array | string): `sha256:${string}` =>
  `sha256:${createHash("sha256")
    .update(`spawnfile.local-evidence-export-helper.${domain}.v1\0`, "utf8")
    .update(bytes)
    .digest("hex")}`;

export const loadLocalEvidenceHelperRecipe = async (): Promise<LocalEvidenceHelperRecipe> => {
  const source = await readFile(new URL("./helperProgram.mjs", import.meta.url));
  if (source.byteLength < 1 || source.byteLength > MAX_SOURCE_BYTES
    || !source.subarray(0, 22).toString("utf8").startsWith("#!/usr/local/bin/node")) return fail();
  const context = archive([
    { bytes: dockerfile, mode: 0o444, path: "Dockerfile" },
    { bytes: source, mode: 0o555, path: "helperProgram.mjs" },
  ]);
  const recipeDigest = digest("recipe", context);
  const artifactManifestDigest = digest("artifact-manifest", recipeDigest);
  if (!DIGEST.test(recipeDigest) || !DIGEST.test(artifactManifestDigest)) return fail();
  return Object.freeze({ artifactManifestDigest, context, recipeDigest });
};
