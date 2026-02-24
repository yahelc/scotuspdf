import { getStore } from '@netlify/blobs';

const SCOTUS_URL = 'https://www.supremecourt.gov';

interface CalendarCache {
  conferenceDays: number[];
  fetchedAt: string;
}

/**
 * Returns true if the given UTC timestamp falls within US Eastern Daylight Time
 * (second Sunday of March to first Sunday of November).
 */
function isEDT(date: Date): boolean {
  const year = date.getUTCFullYear();

  // Second Sunday of March: find first Sunday in March, then add 7 days
  const mar1 = new Date(Date.UTC(year, 2, 1));
  const firstSunMar = (7 - mar1.getUTCDay()) % 7;
  const secondSunMar = Date.UTC(year, 2, 1 + firstSunMar + 7, 7); // 2am EST = 7am UTC

  // First Sunday of November
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstSunNov = (7 - nov1.getUTCDay()) % 7;
  const firstSunNovMs = Date.UTC(year, 10, 1 + firstSunNov, 6); // 2am EDT = 6am UTC

  return date.getTime() >= secondSunMar && date.getTime() < firstSunNovMs;
}

/** Convert a Date to Eastern Time hours and minutes. */
export function toEasternTime(date: Date): { hours: number; minutes: number; dayOfMonth: number; month: number; year: number } {
  const offsetHours = isEDT(date) ? -4 : -5;
  const et = new Date(date.getTime() + offsetHours * 3600_000);
  return {
    hours: et.getUTCHours(),
    minutes: et.getUTCMinutes(),
    dayOfMonth: et.getUTCDate(),
    month: et.getUTCMonth(),
    year: et.getUTCFullYear(),
  };
}

/**
 * Parse the specialDaysArray from the SCOTUS homepage HTML.
 * Returns day-of-month numbers that are conference days.
 */
export function parseConferenceDays(html: string): number[] {
  // The calendar embeds something like:
  // var defined = [[2025,4,5,"Conference Day"],[2025,4,12,"Non-argument Day"], ...]
  // or specialDaysArray = [...]
  const match = html.match(/(?:specialDaysArray|defined)\s*=\s*\[(\[[\s\S]*?\])\s*\]/);
  if (!match) return [];

  const days: number[] = [];
  // Match individual entries like [2025,4,5,"Conference Day"]
  const entryRegex = /\[\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*"([^"]+)"\s*\]/g;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(match[1])) !== null) {
    const label = entryMatch[4];
    if (/conference/i.test(label)) {
      days.push(Number(entryMatch[3]));
    }
  }
  return days;
}

/**
 * Fetch conference days for the current month from SCOTUS homepage.
 * Caches result in Netlify Blobs with a daily key so it re-scrapes daily.
 */
export async function getConferenceDays(now?: Date): Promise<number[]> {
  const date = now ?? new Date();
  const et = toEasternTime(date);
  const dateKey = `${et.year}-${String(et.month + 1).padStart(2, '0')}-${String(et.dayOfMonth).padStart(2, '0')}`;
  const blobKey = `calendar/${dateKey}.json`;

  try {
    const store = getStore('scotus-calendar');
    const cached = await store.get(blobKey, { type: 'json' }) as CalendarCache | null;
    if (cached) return cached.conferenceDays;
  } catch {
    // Blob read failed — fall through to scrape
  }

  try {
    const resp = await fetch(SCOTUS_URL);
    if (!resp.ok) return [];
    const html = await resp.text();
    const conferenceDays = parseConferenceDays(html);

    // Cache result
    try {
      const store = getStore('scotus-calendar');
      const cacheData: CalendarCache = { conferenceDays, fetchedAt: date.toISOString() };
      await store.setJSON(blobKey, cacheData);
    } catch {
      // Non-fatal
    }

    return conferenceDays;
  } catch {
    return [];
  }
}

/**
 * Returns true if today is a conference day AND current time is 9:55am–12:30pm ET.
 */
export async function isConferenceWindow(now?: Date): Promise<boolean> {
  const date = now ?? new Date();
  const et = toEasternTime(date);

  // Check time window: 9:55am to 12:30pm ET
  const minutesSinceMidnight = et.hours * 60 + et.minutes;
  const windowStart = 9 * 60 + 55; // 9:55am
  const windowEnd = 12 * 60 + 30; // 12:30pm
  if (minutesSinceMidnight < windowStart || minutesSinceMidnight >= windowEnd) {
    return false;
  }

  const conferenceDays = await getConferenceDays(date);
  return conferenceDays.includes(et.dayOfMonth);
}
