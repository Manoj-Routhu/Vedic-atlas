/** "820 ms", "1.2 s", "75 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "4:30 pm". Built by hand so it reads the same on every phone and locale. */
function clock(d: Date): string {
  const h = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${minutes} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Today 4:30 pm", "Tomorrow 9:00 am", "Thu 9:00 am", or "12 Nov 6:15 pm". Empty when there is nothing to show. */
export function formatWhen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const time = clock(when);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[when.getDay()]} ${time}`;
  return `${when.getDate()} ${MONTHS[when.getMonth()]} ${time}`;
}

/** "15 min before", "30 and 10 min before", "5, 10 and 15 min before". */
export function describeLeads(minutes: number[]): string {
  if (minutes.length === 0) return 'No heads-up';
  const list = minutes.length === 1 ? `${minutes[0]}` : `${minutes.slice(0, -1).join(', ')} and ${minutes[minutes.length - 1]}`;
  return `${list} min before`;
}

/** What the camera model is doing, in words. */
export function describeCameraModel(v: { enabled: boolean; loaded: boolean; busy: boolean }): string {
  if (!v.enabled) return 'off';
  if (v.busy) return 'working';
  return v.loaded ? 'ready' : 'asleep (wakes on the first photo)';
}
