import type { RuntimeInstallRecipe } from "../runtime/container.js";
import { SpawnfileError } from "../shared/index.js";

type ImageChoice = Pick<RuntimeInstallRecipe, "baseImage" | "requiredBaseImage">;

export function selectContainerBaseImage(standalone: readonly string[], recipes: readonly ImageChoice[]): string {
  const required = [...new Set(recipes.flatMap(recipe => recipe.requiredBaseImage ? [recipe.requiredBaseImage] : []))];
  if (required.length > 1) {
    throw new SpawnfileError("compile_error", `Runtime installations require incompatible container base images: ${required.join(", ")}`);
  }
  if (required.length) return required[0]!;

  const preferred = [...new Set(recipes.flatMap(recipe => recipe.baseImage ? [recipe.baseImage] : []))];
  if (preferred.length === 1 && standalone.length === recipes.length) return preferred[0]!;
  if (standalone.length <= 1) return standalone[0] ?? "debian:bookworm-slim";

  const major = (image: string) => Number(image.match(/^node:(\d+)/u)?.[1] ?? "0");
  return standalone.filter(image => image.startsWith("node:")).sort((a, b) => major(b) - major(a))[0]
    ?? "debian:bookworm-slim";
}
