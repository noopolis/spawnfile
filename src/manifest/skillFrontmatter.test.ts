import { describe, expect, it } from "vitest";

import { parseSkillFrontmatter } from "./skillFrontmatter.js";

describe("parseSkillFrontmatter", () => {
  it("parses required fields", () => {
    expect(
      parseSkillFrontmatter(
        ["---", 'name: web_search', 'description: "Search."', "---", "", "body"].join("\n")
      )
    ).toEqual({
      description: "Search.",
      name: "web_search"
    });
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseSkillFrontmatter("# nope")).toThrowError(/frontmatter/);
  });

  it("rejects frontmatter without the required fields", () => {
    expect(() =>
      parseSkillFrontmatter(["---", "name: web_search", "---", "", "body"].join("\n"))
    ).toThrowError(/name and description/);
  });
});
