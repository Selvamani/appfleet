const timeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
});

/** "14:01:12" in UTC. */
export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** "1 Oct" in UTC. */
export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

/** "Today 14:01" or "1 Oct, 14:01", in UTC. */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const sameDay = new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return sameDay ? `Today ${timeFmt.format(d).slice(0, 5)}` : dateTimeFmt.format(d);
}

/** "3 s", "4 min", "2 h", "3 d". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** "3 s ago". */
export function formatAgo(iso: string, now: number = Date.now()): string {
  return `${formatDuration(now - new Date(iso).getTime())} ago`;
}

/**
 * Compact id for display: first 8 and last 4 characters. UUIDv7 ids created together share their
 * leading timestamp, so the tail is what tells them apart. Put the full id in a title attribute.
 */
export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
