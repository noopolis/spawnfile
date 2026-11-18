import type { RuntimeInstallSelection } from "./install.js";

export type NativeInstallHintProfile = Record<
  RuntimeInstallSelection["kind"],
  { ecosystem: "go" | "node"; installHint: string }
>;

export interface NativeInstallRecipeInput {
  containerEnv: Record<string, string>;
  installRoot: string;
  runtimeName: string;
  selection: RuntimeInstallSelection;
}

export const createRuntimeImageCopyCommand = (
  imageRef: string,
  runtimeRoot: string
): string => `COPY --from=${imageRef} ${runtimeRoot} ${runtimeRoot}`;

export const resolveRuntimeImageRef = (
  envName: string,
  selection: RuntimeInstallSelection
): string | undefined =>
  process.env[envName]?.trim() ||
  (selection.kind === "container_image"
    ? `${selection.image}:${selection.tag}`
    : undefined);
