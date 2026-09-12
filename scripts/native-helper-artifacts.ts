import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const expectedMachine = { x64: 62, arm64: 183 } as const;
type NativeArchitecture = keyof typeof expectedMachine;

type NativeHelperProvenance = {
  architecture: NativeArchitecture;
  binary_sha256: string;
  builder_image: string;
  compiler: string;
  source_sha256: string;
  target: string;
  version: "spawnfile.rename-noreplace-build.v1";
};

const nativeArchitectures = Object.keys(expectedMachine) as NativeArchitecture[];

const isNativeHelperProvenance = (
  value: unknown,
): value is NativeHelperProvenance => (
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && typeof (value as { architecture?: unknown }).architecture === "string"
  && typeof (value as { binary_sha256?: unknown }).binary_sha256 === "string"
  && typeof (value as { builder_image?: unknown }).builder_image === "string"
  && typeof (value as { compiler?: unknown }).compiler === "string"
  && typeof (value as { source_sha256?: unknown }).source_sha256 === "string"
  && typeof (value as { target?: unknown }).target === "string"
  && (value as { version?: unknown }).version === "spawnfile.rename-noreplace-build.v1"
);

export const verifyNativeHelperArtifacts = async (root: string): Promise<void> => {
  for (const architecture of nativeArchitectures) {
    const binaryPath = path.join(root, `rename-noreplace-${architecture}`);
    const provenancePath = `${binaryPath}.provenance.json`;
    let binary: Buffer;
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      [binary, metadata] = await Promise.all([readFile(binaryPath), lstat(binaryPath)]);
    } catch {
      throw new Error(`Missing Linux ${architecture} rename-noreplace helper`);
    }
    if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || !(metadata.mode & 0o111)
      || binary.subarray(0, 4).toString("hex") !== "7f454c46"
      || binary.readUInt16LE(18) !== expectedMachine[architecture]) {
      throw new Error(`Wrong-architecture or unsafe Linux ${architecture} rename-noreplace helper`);
    }
    let provenance: unknown;
    try {
      provenance = JSON.parse(await readFile(provenancePath, "utf8")) as unknown;
    } catch {
      throw new Error(`Missing Linux ${architecture} rename-noreplace provenance`);
    }
    const digest = `sha256:${createHash("sha256").update(binary).digest("hex")}`;
    if (!isNativeHelperProvenance(provenance)
      || provenance.architecture !== architecture
      || provenance.target !== `linux/${architecture === "x64" ? "amd64" : "arm64"}`
      || provenance.binary_sha256 !== digest
      || provenance.builder_image
        !== "gcc:14.2.0@sha256:b99b86a28812b1e6453a231a947dc43d76fe192788a12f344a9b568bf9f5d24c"
      || provenance.compiler !== "gcc:14.2.0"
      || !/^sha256:[a-f0-9]{64}$/u.test(provenance.source_sha256)) {
      throw new Error(`Invalid Linux ${architecture} rename-noreplace provenance`);
    }
  }
};
