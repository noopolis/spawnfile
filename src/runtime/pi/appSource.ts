import { renderPiActivitySource } from "./appActivitySource.js";
import { renderPiCoreSource } from "./appCoreSource.js";
import { renderPiPreludeSource } from "./appPreludeSource.js";

export const renderPiApp = (): string => [
  renderPiPreludeSource(),
  renderPiActivitySource(),
  renderPiCoreSource()
].join("\n\n");
