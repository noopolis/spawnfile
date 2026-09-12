import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../../dist/evidenceExportHelper/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL("./helperProgram.mjs", import.meta.url),
  new URL("helperProgram.mjs", destination),
);
