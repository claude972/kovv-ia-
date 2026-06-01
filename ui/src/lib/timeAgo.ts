const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return "à l'instant";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return `il y a ${m} min`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return `il y a ${h} h`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return `il y a ${d} j`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return `il y a ${w} sem`;
  }
  const mo = Math.floor(seconds / MONTH);
  return `il y a ${mo} mois`;
}
