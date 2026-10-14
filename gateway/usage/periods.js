// Onyx Gateway: budget periods and usage days in the Settings time zone (an IANA name such as
// America/Toronto). Weeks start on Monday. DST is handled by asking Intl for the zone's offset.

const DAY_MS = 86_400_000;
const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(tz, f);
  }
  return f;
}

/** A zone this runtime knows, else UTC. */
export function safeZone(tz) {
  if (!tz) return "UTC";
  try {
    formatter(tz);
    return tz;
  } catch {
    return "UTC";
  }
}

/** Local calendar fields of an instant in a zone. */
export function zonedParts(ms, tz) {
  const p = Object.fromEntries(formatter(safeZone(tz)).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second), weekday: p.weekday };
}

/** The zone's offset from UTC at an instant, in ms (positive east of UTC). */
function offsetAt(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local calendar day starts (local 00:00, or the first moment after if skipped). */
export function zonedMidnight(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDay(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

const WEEKDAY = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/**
 * The period containing an instant.
 * @param {"day" | "week" | "month"} period
 * @returns {{ start: number, end: number, key: string }}  end is the next period's start
 */
export function periodBounds(period, ms, tz) {
  const zone = safeZone(tz);
  const p = zonedParts(ms, zone);
  if (period === "month") {
    const start = zonedMidnight(p.y, p.m, 1, zone);
    const end = p.m === 12 ? zonedMidnight(p.y + 1, 1, 1, zone) : zonedMidnight(p.y, p.m + 1, 1, zone);
    return { start, end, key: `${p.y}-${String(p.m).padStart(2, "0")}` };
  }
  // Day arithmetic on a UTC calendar date, then mapped back to the zone's midnight.
  const base = Date.UTC(p.y, p.m - 1, p.d);
  const back = period === "week" ? WEEKDAY[p.weekday] ?? 0 : 0;
  const len = period === "week" ? 7 : 1;
  const s = new Date(base - back * DAY_MS);
  const e = new Date(base + (len - back) * DAY_MS);
  const start = zonedMidnight(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate(), zone);
  const end = zonedMidnight(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate(), zone);
  return { start, end, key: `${period}:${localDay(start, zone)}` };
}

/** "Nov 1", "Mon Oct 20" style label for when a period resets. */
export function resetLabel(period, ms, tz) {
  const { end } = periodBounds(period, ms, tz);
  const opts = period === "week" ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat("en-US", { timeZone: safeZone(tz), ...opts }).format(new Date(end)).replace(",", "");
}
