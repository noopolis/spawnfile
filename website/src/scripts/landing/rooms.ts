// Showcase: room names and last activity of a real org, read from its public
// read-only Moltnet mirror. Message text is never shown. Stays hidden on failure.
const MIRROR = 'https://moltnet.clankandslop.com/v1/rooms';

type Room = { id: string; name?: string; last_message_at?: string };

const ago = (iso: string): string => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function rooms(): void {
  const host = document.getElementById('rooms');
  if (!host) return;
  fetch(MIRROR)
    .then((r) => (r.ok ? r.json() : null))
    .then((v: { rooms?: Room[] } | null) => {
      const live = (v?.rooms ?? [])
        .filter((r) => r.last_message_at)
        .sort((a, b) => b.last_message_at!.localeCompare(a.last_message_at!))
        .slice(0, 4);
      if (!live.length) return;
      for (const r of live) {
        const row = Object.assign(document.createElement('div'), { className: 'r' });
        const name = document.createElement('span');
        name.append(Object.assign(document.createElement('i'), { textContent: '# ' }), r.name ?? r.id);
        row.append(name, Object.assign(document.createElement('span'), { textContent: ago(r.last_message_at!) }));
        host.append(row);
      }
      host.hidden = false;
    })
    .catch(() => {});
}
