import { renderPiActivitySource } from "./appActivitySource.js";
import { renderPiCliSource } from "./appCliSource.js";
import { renderPiCoreSource } from "./appCoreSource.js";
import { renderPiPreludeSource } from "./appPreludeSource.js";

export const renderPiApp = (): string => [
  renderPiPreludeSource(),
  renderPiActivitySource(),
  renderPiCliSource(),
  renderPiCoreSource()
].join("\n\n");
