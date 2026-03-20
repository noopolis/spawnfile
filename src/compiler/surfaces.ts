import { readUtf8File, resolveProjectPath } from "../filesystem/index.js";
import {
  DocsBlock,
  McpServer,
  Secret,
  SharedSurface,
  SkillReference
} from "../manifest/index.js";
import { parseSkillFrontmatter } from "../manifest/index.js";
import { StringMap } from "../shared/index.js";

import { ResolvedDocument, ResolvedSkill } from "./types.js";

const mergeByKey = <TValue>(
  sharedValues: TValue[],
  localValues: TValue[],
  getKey: (value: TValue) => string
): TValue[] => {
  const values = new Map<string, TValue>();

  for (const value of sharedValues) {
    values.set(getKey(value), value);
  }

  for (const value of localValues) {
    values.set(getKey(value), value);
  }

  return [...values.values()];
};

export const mergeSkills = (
  sharedSkills: SkillReference[] = [],
  localSkills: SkillReference[] = []
): SkillReference[] => mergeByKey(sharedSkills, localSkills, (skill) => skill.ref);

export const mergeResolvedSkills = (
  sharedSkills: ResolvedSkill[] = [],
  localSkills: ResolvedSkill[] = []
): ResolvedSkill[] => mergeByKey(sharedSkills, localSkills, (skill) => skill.ref);

export const mergeMcpServers = (
  sharedServers: McpServer[] = [],
  localServers: McpServer[] = []
): McpServer[] => mergeByKey(sharedServers, localServers, (server) => server.name);

export const mergeSecrets = (
  sharedSecrets: Secret[] = [],
  localSecrets: Secret[] = []
): Secret[] => mergeByKey(sharedSecrets, localSecrets, (secret) => secret.name);

export const mergeEnv = (
  sharedEnv: StringMap = {},
  localEnv: StringMap = {}
): StringMap => ({
  ...sharedEnv,
  ...localEnv
});

export const loadResolvedDocuments = async (
  manifestPath: string,
  docs: DocsBlock | undefined
): Promise<ResolvedDocument[]> => {
  if (!docs) {
    return [];
  }

  const documents: Array<[string, string]> = [
    ["heartbeat", docs.heartbeat],
    ["identity", docs.identity],
    ["memory", docs.memory],
    ["soul", docs.soul],
    ["system", docs.system],
    ...Object.entries(docs.extras ?? {}).map(([name, relativePath]) => [`extras.${name}`, relativePath])
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return Promise.all(
    documents.map(async ([role, relativePath]) => {
      const sourcePath = resolveProjectPath(manifestPath, relativePath);

      return {
        content: await readUtf8File(sourcePath),
        role,
        sourcePath
      };
    })
  );
};

export const loadResolvedSkills = async (
  manifestPath: string,
  skills: SkillReference[] = []
): Promise<ResolvedSkill[]> =>
  Promise.all(
    skills.map(async (skill) => {
      const sourcePath = resolveProjectPath(manifestPath, `${skill.ref}/SKILL.md`);
      const content = await readUtf8File(sourcePath);
      const frontmatter = parseSkillFrontmatter(content);

      return {
        content,
        name: frontmatter.name,
        ref: skill.ref,
        requiresMcp: skill.requires?.mcp ?? [],
        sourcePath
      };
    })
  );

export const mergeSharedSurface = (
  shared: SharedSurface | undefined,
  local: {
    env: StringMap | undefined;
    mcpServers: McpServer[] | undefined;
    secrets: Secret[] | undefined;
    skills: SkillReference[] | undefined;
  }
): {
  env: StringMap;
  mcpServers: McpServer[];
  secrets: Secret[];
  skills: SkillReference[];
} => ({
  env: mergeEnv(shared?.env, local.env),
  mcpServers: mergeMcpServers(shared?.mcp_servers, local.mcpServers),
  secrets: mergeSecrets(shared?.secrets, local.secrets),
  skills: mergeSkills(shared?.skills, local.skills)
});
