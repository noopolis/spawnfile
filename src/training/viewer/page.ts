import type { ViewerData } from './types.js';
import { renderCockpit } from './cockpit/index.js';

export { escapeHtml, cockpitStyles as viewerStyles, cockpitScript as viewerScript } from './cockpit/index.js';

/** Render only the authorized, schema-validated experiment projection. */
export function renderViewer(data: ViewerData, nonce: string, metricIndex = 0): string {
  return renderCockpit(data, nonce, metricIndex);
}
