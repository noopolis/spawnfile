import { parse as parseYaml } from "yaml";

import { SpawnfileError } from "../shared/index.js";

export interface SkillFrontmatter {
  description: string;
  name: string;
}

const readFrontmatterBlock = (source: string): string => {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new SpawnfileError(
      "validation_error",
      "SKILL.md must begin with YAML frontmatter"
    );
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    throw new SpawnfileError(
      "validation_error",
      "SKILL.md must begin with YAML frontmatter"
    );
  }

  return lines.slice(1, closingIndex).join("\n");
};

export const parseSkillFrontmatter = (source: string): SkillFrontmatter => {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFrontmatterBlock(source));
  } catch {
    throw new SpawnfileError(
      "validation_error",
      "SKILL.md frontmatter must be valid YAML"
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).name !== "string" ||
    typeof (parsed as Record<string, unknown>).description !== "string"
  ) {
    throw new SpawnfileError(
      "validation_error",
      "Skill frontmatter must declare name and description"
    );
  }

  return {
    description: (parsed as Record<string, string>).description,
    name: (parsed as Record<string, string>).name
  };
};
