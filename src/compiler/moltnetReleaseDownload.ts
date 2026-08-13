import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";
import {
  parseTrustedMoltnetReleaseAuthority,
  trustedMoltnetReleaseAsset,
  type MoltnetTargetArchitecture,
  type TrustedMoltnetReleaseAuthority
} from "./moltnetReleaseAuthority.js";

const MAX_RELEASE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

type ReleaseResponse = Pick<
  Response,
  "body" | "headers" | "ok" | "status" | "statusText"
>;

export interface MoltnetReleaseDownloadDependencies {
  readonly fetchRelease?: (
    input: string,
    init: RequestInit
  ) => Promise<ReleaseResponse>;
}

export interface DownloadedMoltnetReleaseAsset {
  readonly assetPath: string;
  readonly cleanup: () => Promise<void>;
}

export const trustedMoltnetReleaseDownloadUrl = (
  authority: TrustedMoltnetReleaseAuthority,
  architecture: MoltnetTargetArchitecture
): string => {
  const parsed = parseTrustedMoltnetReleaseAuthority(authority);
  const asset = trustedMoltnetReleaseAsset(parsed, architecture);
  return `https://github.com/noopolis/moltnet/releases/download/${parsed.release_version}/${asset.asset}`;
};

const responseBytes = async (response: ReleaseResponse): Promise<Buffer> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RELEASE_BYTES) {
      throw new SpawnfileError("compile_error", "Pinned Moltnet release has an invalid content length");
    }
  }
  if (response.body === null) {
    throw new SpawnfileError("compile_error", "Pinned Moltnet release response has no body");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RELEASE_BYTES) {
        await reader.cancel();
        throw new SpawnfileError("compile_error", "Pinned Moltnet release exceeds the download limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new SpawnfileError("compile_error", "Pinned Moltnet release is empty");
  return Buffer.concat(chunks, total);
};

export const downloadTrustedMoltnetReleaseAsset = async (
  authority: TrustedMoltnetReleaseAuthority,
  architecture: MoltnetTargetArchitecture,
  dependencies: MoltnetReleaseDownloadDependencies = {}
): Promise<DownloadedMoltnetReleaseAsset> => {
  const parsed = parseTrustedMoltnetReleaseAuthority(authority);
  const asset = trustedMoltnetReleaseAsset(parsed, architecture);
  const url = trustedMoltnetReleaseDownloadUrl(parsed, architecture);
  const fetchRelease = dependencies.fetchRelease ?? fetch;
  let response: ReleaseResponse;
  try {
    response = await fetchRelease(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError("compile_error", `Unable to download pinned Moltnet release: ${reason}`);
  }
  if (!response.ok) {
    throw new SpawnfileError(
      "compile_error",
      `Unable to download pinned Moltnet release: HTTP ${response.status} ${response.statusText}`
    );
  }
  const bytes = await responseBytes(response);
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (sha256 !== asset.asset_sha256) {
    throw new SpawnfileError("compile_error", "Downloaded Moltnet release digest does not match trusted authority");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-release-"));
  try {
    const assetPath = path.join(directory, asset.asset);
    await writeFile(assetPath, bytes, { flag: "wx" });
    return Object.freeze({
      assetPath,
      cleanup: () => rm(directory, { force: true, recursive: true })
    });
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};
