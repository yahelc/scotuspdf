import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Run every minute, weekdays, during 2–5pm UTC (covers 9:55am–1pm ET in both EST/EDT)
export const config: Config = { schedule: "* 14-17 * * 1-5" };

function isEDT(date: Date): boolean {
  const year = date.getUTCFullYear();
  const mar1 = new Date(Date.UTC(year, 2, 1));
  const firstSunMar = (7 - mar1.getUTCDay()) % 7;
  const secondSunMar = Date.UTC(year, 2, 1 + firstSunMar + 7, 7);
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstSunNov = (7 - nov1.getUTCDay()) % 7;
  const firstSunNovMs = Date.UTC(year, 10, 1 + firstSunNov, 6);
  return date.getTime() >= secondSunMar && date.getTime() < firstSunNovMs;
}

function toEasternTime(date: Date) {
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

async function isConferenceWindow(): Promise<boolean> {
  const now = new Date();
  const et = toEasternTime(now);

  // Check time window: 9:55am to 12:30pm ET
  const mins = et.hours * 60 + et.minutes;
  if (mins < 9 * 60 + 55 || mins >= 12 * 60 + 30) return false;

  // Read calendar from Blob
  const dateKey = `${et.year}-${String(et.month + 1).padStart(2, '0')}-${String(et.dayOfMonth).padStart(2, '0')}`;
  try {
    const store = getStore('scotus-calendar');
    const cached = await store.get(`calendar/${dateKey}.json`, { type: 'json' }) as { conferenceDays: number[] } | null;
    if (cached) return cached.conferenceDays.includes(et.dayOfMonth);
  } catch {
    // Fall through
  }

  // If no cached calendar, fetch it (first invocation of the day)
  try {
    const resp = await fetch('https://www.supremecourt.gov');
    if (!resp.ok) return false;
    const html = await resp.text();
    const match = html.match(/(?:specialDaysArray|defined)\s*=\s*\[(\[[\s\S]*?\])\s*\]/);
    if (!match) return false;
    const days: number[] = [];
    const entryRegex = /\[\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*"([^"]+)"\s*\]/g;
    let entryMatch;
    while ((entryMatch = entryRegex.exec(match[1])) !== null) {
      if (/conference/i.test(entryMatch[4])) days.push(Number(entryMatch[3]));
    }
    // Cache for the day
    try {
      const store = getStore('scotus-calendar');
      await store.setJSON(`calendar/${dateKey}.json`, { conferenceDays: days, fetchedAt: now.toISOString() });
    } catch { /* non-fatal */ }
    return days.includes(et.dayOfMonth);
  } catch {
    return false;
  }
}

export default async function() {
  const inWindow = await isConferenceWindow();
  if (!inWindow) return;

  const siteUrl = process.env.URL || "https://scotuspdf.com";
  try {
    const resp = await fetch(`${siteUrl}/api/recent?refresh=true`);
    if (!resp.ok) {
      console.error(`refresh-recent: API returned ${resp.status}`);
      return;
    }
    console.log("refresh-recent: pre-warmed recent opinions cache");
  } catch (err) {
    console.error("refresh-recent: fetch failed", err);
  }
}
