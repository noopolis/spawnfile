import { SpawnfileError } from "../shared/index.js";

const LABEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export const normalizeProjectLabelSlug = (projectName: string): string => {
  const slug = projectName
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");

  if (!slug || !LABEL_VALUE_PATTERN.test(slug)) {
    throw new SpawnfileError(
      "validation_error",
      `Project name ${JSON.stringify(projectName)} cannot be normalized into a label-safe slug`
    );
  }

  return slug;
};
