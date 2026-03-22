import { readFileSync } from "node:fs";

export const loadRuntimeScaffoldAsset = (
  moduleUrl: string,
  assetName: string
): string => readFileSync(new URL(`./scaffold-assets/${assetName}`, moduleUrl), "utf8");
