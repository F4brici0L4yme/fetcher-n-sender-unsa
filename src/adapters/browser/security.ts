import { createHash } from 'node:crypto';
import { normalizeDeadline } from '../../core/domain/deadline';
import { BrowserSessionError } from '../../core/domain/browser-session';

export function normalizeIdentity(value: string): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@/\\<>\x00-\x1f]+@[^\s@/\\<>\x00-\x1f]+\.[^\s@/\\<>\x00-\x1f]+$/.test(value.trim())) {
    throw new BrowserSessionError('invalid_identity', 'Ingresa el correo que aparece en tu perfil de Aula Virtual.');
  }
  return value.trim().toLowerCase();
}

export function accountKey(namespace: string, portal: string, identity: string): string {
  return 'aula-' + createHash('sha256').update(JSON.stringify([namespace, new URL(portal).href, normalizeIdentity(identity)])).digest('hex');
}

export function validatePortalLink(value: string, portal: string, readOnly: boolean): string | null {
  try {
    const root = new URL(portal);
    const url = new URL(value, root);
    if (url.protocol !== 'https:' || url.origin !== root.origin || url.username || url.password
      || !url.pathname.startsWith(root.pathname) || /(?:logout|delete|remove|enrol)\.php$/i.test(url.pathname)) return null;
    if (readOnly && (url.searchParams.has('sesskey') || [...url.searchParams.keys()].some((key) => /^(action|delete|remove|submit|confirm)$/i.test(key)))) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

const MOODLE_MONTHS: Readonly<Record<string, number>> = {
  enero: 1, ene: 1, january: 1, jan: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, abr: 4, april: 4, apr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, ago: 8, august: 8, aug: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, set: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dic: 12, december: 12, dec: 12,
};

export function parseMoodleDeadline(value: string): string | null {
  const normalized = value.replace(/[\u00a0\u202f]/g, ' ').trim();
  const text = normalized.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}(?:t|$)/i.test(text)) {
    try { return normalizeDeadline(normalized); } catch { return null; }
  }
  const match = text.match(
    /\b(\d{1,2})\s+(?:de\s+)?([a-z]+)\.?\s+(?:de\s+)?(\d{4})(?:(?:,\s*|\s+(?:a\s+las\s+)?)(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\.?(?!\w))?)?/i,
  );
  if (!match) return null;
  const month = MOODLE_MONTHS[match[2]!];
  if (!month) return null;
  const date = `${match[3]}-${String(month).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  if (!match[4]) {
    try { return normalizeDeadline(date); } catch { return null; }
  }
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const meridiem = match[6]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'a') hour = hour === 12 ? 0 : hour;
    else if (meridiem === 'p') hour = hour === 12 ? 12 : hour + 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  try {
    return normalizeDeadline(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-05:00`);
  } catch {
    return null;
  }
}
