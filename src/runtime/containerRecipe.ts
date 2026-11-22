import type { RuntimeInstallRecipe } from "./container.js";
import type { RuntimeContainerPackageOverrides } from "./containerPackageOverrides.js";
import type { RuntimeInstallSelection } from "./install.js";

export type NativeInstallHintProfile = Record<
  RuntimeInstallSelection["kind"],
  { ecosystem: "go" | "node"; installHint: string }
>;

export interface NativeInstallRecipeInput {
  containerEnv: Record<string, string>;
  installRoot: string;
  packageOverrides?: RuntimeContainerPackageOverrides;
  runtimeName: string;
  selection: RuntimeInstallSelection;
}

export interface RuntimeInstallCapability {
  readonly hints: NativeInstallHintProfile;
  createRecipe(input: NativeInstallRecipeInput): RuntimeInstallRecipe | Promise<RuntimeInstallRecipe>;
}

/** Keep npm's executable and module paths stable on bases with a private Node prefix. */
export const globalNpmInstallCommand = (specs: readonly string[]): string =>
  `npm install -g --prefix /usr/local --omit=dev --no-fund --no-audit ${specs.join(" ")}`;

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
