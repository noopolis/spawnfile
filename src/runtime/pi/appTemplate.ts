import type { PiGeneratedAgent } from "./appTemplateTypes.js";

export { renderPiApp } from "./appSource.js";
export {
  resolveScriptedEngineCommandOption,
  resolveScriptedEngineStagedPath,
  SCRIPTED_ENGINE_STAGED_DIRECTORY
} from "./appScriptedEngine.js";
export {
  createPiAgentConfig,
  isPiEveryScheduleValue,
  renderPiModelsConfig,
  resolvePiEngine,
  resolvePiRawTrainingCapture,
  resolvePiThinkingFormat,
  resolvePiThinkingLevel,
  resolvePiTools
} from "./appAgentConfig.js";
export {
  PI_BUILTIN_TOOLS,
  PI_ENGINE_KINDS,
  PI_HARNESS_SYSTEM_PROMPT,
  PI_THINKING_FORMATS,
  PI_THINKING_LEVELS,
  type PiGeneratedAgent
} from "./appTemplateTypes.js";

export const DAIMON_PACKAGE_NAME = "@noopolis/daimon";
export const DAIMON_PACKAGE_VERSION = "0.1.2";
export const MNEME_PACKAGE_NAME = "@noopolis/mneme";
export const MNEME_PACKAGE_VERSION = "0.1.1";
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
export const PI_PACKAGE_VERSION = "0.79.10";

const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const renderPiPackageJson = (): string =>
  serializeJson({
    dependencies: {
      [DAIMON_PACKAGE_NAME]: DAIMON_PACKAGE_VERSION,
      [MNEME_PACKAGE_NAME]: MNEME_PACKAGE_VERSION,
      yaml: "^2.8.1",
      [PI_AI_PACKAGE_NAME]: PI_PACKAGE_VERSION,
      [PI_PACKAGE_NAME]: PI_PACKAGE_VERSION
    },
    private: true,
    type: "module"
  });

export const renderPiAppConfig = (agents: PiGeneratedAgent[]): string =>
  serializeJson({
    agents,
    version: "spawnfile.pi-app.v1"
  });
