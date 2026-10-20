import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { createDaimonInstallCommands } from "../src/runtime/daimonInstall.ts";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "../src/runtime/daimon/contractManifest.ts";
import { parseTrustedMoltnetReleaseAuthority, trustedMoltnetReleaseAsset } from "../src/compiler/moltnetReleaseAuthority.ts";
import { trustedMoltnetReleaseDownloadUrl } from "../src/compiler/moltnetReleaseDownload.ts";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const daimonPin = z.object({
  kind: z.literal("container_image"),
  image: z.string().regex(/^(?:docker\.io\/)?noopolis\/spawnfile-runtime-daimon$/u),
  tag: z.string().regex(/^[\w][\w.-]{0,99}$/u),
  digest,
  capability_receipts: z.object({ amd64: digest, arm64: digest }),
  contract_manifest_sha256: z.literal(DAIMON_CONTRACT_MANIFEST_SHA256)
});

/** No environment overrides or local identities: publication consumes checked-in pins only. */
export const parseTrainingNativeInputs = (registry: unknown, release: unknown) => {
  const parsed = z.object({ runtimes: z.object({ daimon: z.object({ install: daimonPin }) }) }).parse(registry);
  const daimon = parsed.runtimes.daimon.install;
  const moltnet = parseTrustedMoltnetReleaseAuthority(release);
  for (const arch of ["amd64", "arm64"] as const) trustedMoltnetReleaseAsset(moltnet, arch);
  return { daimon, moltnet, tag: `${daimon.tag}-moltnet-${moltnet.release_version}` };
};

export type TrainingNativeInputs = ReturnType<typeof parseTrainingNativeInputs>;

export const readTrainingNativeInputs = (root: string): TrainingNativeInputs =>
  parseTrainingNativeInputs(parseYaml(readFileSync(path.join(root, "runtimes.yaml"), "utf8")),
    JSON.parse(readFileSync(path.join(root, "moltnet-releases.json"), "utf8")));

/** Render the repository-owned template with the same install checks compiled orgs run. */
export const renderTrainingNativeDockerfile = (template: string, inputs: TrainingNativeInputs): string => {
  const { daimon, moltnet } = parseTrainingNativeInputs(
    { runtimes: { daimon: { install: inputs.daimon } } }, inputs.moltnet);
  const cases = (["amd64", "arm64"] as const).map(arch => {
    const asset = trustedMoltnetReleaseAsset(moltnet, arch);
    return `${arch}) url="${trustedMoltnetReleaseDownloadUrl(moltnet, arch)}"; expected=${asset.asset_sha256.slice(7)} ;;`;
  }).join(" ");
  const download = `arch="$(dpkg --print-architecture)" && case "$arch" in ${cases} *) exit 1 ;; esac && curl --fail --location --silent --show-error --max-time 120 "$url" -o /tmp/moltnet.tar.gz && echo "$expected  /tmp/moltnet.tar.gz" | sha256sum -c - && mkdir /tmp/moltnet-extract && tar -xzf /tmp/moltnet.tar.gz -C /tmp/moltnet-extract && install -m 0755 /tmp/moltnet-extract/moltnet /usr/local/bin/moltnet && rm -rf /tmp/moltnet.tar.gz /tmp/moltnet-extract`;
  const replacements: Record<string, string> = {
    DAIMON_IMAGE: `${daimon.image}@${daimon.digest}`,
    DAIMON_INSTALL: createDaimonInstallCommands("/opt/spawnfile/runtime-installs/daimon", daimon.capability_receipts).join(" && \\\n    "),
    MOLTNET_INSTALL: download
  };
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    if (result.split(`@@${key}@@`).length !== 2) throw new Error(`Missing or duplicate ${key} template slot`);
    result = result.replace(`@@${key}@@`, () => value);
  }
  if (result.includes("@@")) throw new Error("Unresolved native image template slot");
  return result;
};

/**
 * The release tag names the pinned upstreams and the rendered recipe's content, so a
 * recipe-only change gets a new tag and an existing tag always means identical bytes.
 */
export const trainingNativeTag = (inputs: TrainingNativeInputs, dockerfile: string): string => {
  const tag = `${inputs.tag}-r${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
  if (!/^[\w][\w.-]{0,127}$/u.test(tag)) throw new Error("Derived training-native tag is invalid");
  return tag;
};
