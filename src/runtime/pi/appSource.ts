import { renderPiActivitySource } from "./appActivitySource.js";
import { renderPiCliEnginesSource } from "./appCliEnginesSource.js";
import { renderPiCliSource } from "./appCliSource.js";
import { renderPiCoreSource } from "./appCoreSource.js";
import { renderPiPreludeSource } from "./appPreludeSource.js";

export interface RenderPiAppOptions {
  world?: boolean;
}

export const renderPiApp = (options: RenderPiAppOptions = {}): string => [
  renderPiPreludeSource(),
  renderPiActivitySource(),
  renderPiCliEnginesSource(),
  renderPiCliSource(),
  renderPiCoreSource(options)
].join("\n\n");
