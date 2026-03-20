import { SpawnfileError } from "../shared/index.js";

export interface SkillFrontmatter {
  description: string;
  name: string;
}

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---/;

export const parseSkillFrontmatter = (source: string): SkillFrontmatter => {
  const match = source.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new SpawnfileError(
      "validation_error",
      "SKILL.md must begin with YAML frontmatter"
    );
  }

  const content = match[1];
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descriptionMatch = content.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descriptionMatch) {
    throw new SpawnfileError(
      "validation_error",
      "Skill frontmatter must declare name and description"
    );
  }

  return {
    description: descriptionMatch[1].trim().replace(/^"(.*)"$/, "$1"),
    name: nameMatch[1].trim().replace(/^"(.*)"$/, "$1")
  };
};
