import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const target = path.join(root, "dist/compiler/training/preparation/assets");
await mkdir(target, { recursive: true });
await cp(path.join(root, "runtime-images/training/Dockerfile"), path.join(target, "Dockerfile"));
await cp(path.join(root, "package-lock.json"), path.join(target, "package-lock.json"));
