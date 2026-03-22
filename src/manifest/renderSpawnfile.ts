import YAML from "yaml";

import type { AgentManifest, TeamManifest } from "./schemas.js";

export const renderSpawnfile = (manifest: AgentManifest | TeamManifest): string =>
  YAML.stringify(manifest);
