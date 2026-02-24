export interface Preferences {
  fontSize: number;
  viewMode: 'paged' | 'scroll';
  theme: 'auto' | 'light' | 'dark';
}

export interface ReadingPosition {
  chapterId: string;
  scrollPercent: number;
  page: number;
}

const PREFS_KEY = 'scotuspdf:prefs';
const POSITION_PREFIX = 'scotuspdf:position:';

const DEFAULT_PREFS: Preferences = {
  fontSize: 18,
  viewMode: 'scroll',
  theme: 'auto',
};

export function loadPreferences(): Preferences {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS;
  try {
    const stored = localStorage.getItem(PREFS_KEY);
    if (stored) return { ...DEFAULT_PREFS, ...JSON.parse(stored) };
  } catch {}
  return DEFAULT_PREFS;
}

export function savePreferences(prefs: Preferences): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

export function loadPosition(caseId: string): ReadingPosition | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const stored = localStorage.getItem(POSITION_PREFIX + caseId);
    if (stored) return JSON.parse(stored);
  } catch {}
  return null;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function savePosition(caseId: string, position: ReadingPosition): void {
  if (typeof localStorage === 'undefined') return;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      localStorage.setItem(POSITION_PREFIX + caseId, JSON.stringify(position));
    } catch {}
  }, 500);
}
