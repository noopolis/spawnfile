import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ViewerData } from './types.js';
import { projectViewerData } from './projection.js';

export interface SnapshotStream { close(finalHtml?: string): Promise<void> }

/** Revisions of persisted, phase-filtered snapshots. Never streams raw trial events. */
export function streamSnapshots(response: ServerResponse, load: () => Promise<ViewerData>, closed: () => void): SnapshotStream {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', Connection: 'close' });
  response.flushHeaders();
  let ended = false, revision = '';
  let closing: Promise<void> | undefined;
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
  return { close(finalHtml) {
    if (closing) return closing;
    ended = true; clearTimeout(timer);
    closing = new Promise<void>(resolve => {
      if (response.destroyed) { resolve(); return; }
      // This is an I/O deadline, not a grace sleep: normal readers close immediately.
      const deadline = setTimeout(() => response.destroy(), 1000);
      response.once('close', () => { clearTimeout(deadline); resolve(); });
      try { response.end(`event: final\ndata: ${JSON.stringify({ html: finalHtml ?? null })}\n\n`); }
      catch { response.destroy(); }
    });
    return closing;
  } };
}
