import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyNativeHelperArtifacts } from "../../../scripts/native-helper-artifacts.mjs";

const source = fileURLToPath(new URL("./artifacts", import.meta.url));
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/deployment/native");

await verifyNativeHelperArtifacts(source);
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await cp(fileURLToPath(new URL("./AGENTS.md", import.meta.url)), path.join(destination, "AGENTS.md"));
await verifyNativeHelperArtifacts(destination);
