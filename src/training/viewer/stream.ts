import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ViewerData } from './types.js';
import { projectViewerData } from './projection.js';

/** Revisions of persisted, phase-filtered snapshots. Never streams raw trial events. */
export function streamSnapshots(response: ServerResponse, load: () => Promise<ViewerData>, closed: () => void): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  response.flushHeaders();
  let ended = false, revision = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  response.once('close', () => { ended = true; clearTimeout(timer); closed(); });
  response.once('error', () => response.destroy());
  const send = (text: string): void => {
    if (ended || response.writableEnded || response.destroyed) return;
    // A slow reader reconnects to the newest snapshot; never queue unbounded history.
    try { if (!response.write(text)) response.destroy(); }
    catch { response.destroy(); }
  };
  const tick = async () => {
    if (ended || response.writableEnded || response.destroyed) return;
    try {
      const data = projectViewerData(await load());
      const next = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if (ended) return;
      if (next !== revision) {
        revision = next;
        send(`event: snapshot\ndata: ${JSON.stringify({ revision })}\n\n`);
      } else send(': heartbeat\n\n');
    } catch {
      send('event: unavailable\ndata: {}\n\n');
    }
    if (!ended && !response.writableEnded && !response.destroyed) timer = setTimeout(() => { void tick(); }, 1000);
  };
  void tick();
}
