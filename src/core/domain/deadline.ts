import { ApplicationError, CapturedAssignment } from './model';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const limaFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function isDateOnly(deadline: string): boolean {
  return datePattern.test(deadline);
}

export function normalizeDeadline(deadline: string | null): string | null {
  if (deadline === null) return null;
  if (typeof deadline !== 'string') throw new ApplicationError('invalid_capture', 'Plazo inválido.');
  const date = deadline.slice(0, 10);
  const midnight = new Date(date + 'T00:00:00Z');
  const validDate = datePattern.test(date) && date.slice(0, 4) !== '0000'
    && Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === date;
  if (!validDate) throw new ApplicationError('invalid_capture', 'Fecha inválida.');
  if (isDateOnly(deadline)) return deadline;
  const instant = new Date(deadline);
  if (!instantPattern.test(deadline) || deadline.slice(11, 13) === '24' || !Number.isFinite(instant.getTime())) {
    throw new ApplicationError('invalid_capture', 'Hora o zona inválida.');
  }
  return instant.toISOString();
}

export function limaDate(now: Date): string {
  return limaFormatter.format(now);
}

export function visibleDeadline(deadline: string | null, now: Date): boolean {
  if (deadline === null) return true;
  return isDateOnly(deadline) ? deadline >= limaDate(now) : Date.parse(deadline) > now.getTime();
}

export function compareDeadline(a: CapturedAssignment, b: CapturedAssignment): number {
  function sortingTime(deadline: string | null) {
    if (deadline === null) return Infinity;
    return Date.parse(isDateOnly(deadline) ? deadline + 'T23:59:59.999-05:00' : deadline);
  }
  return sortingTime(a.deadline) - sortingTime(b.deadline)
    || a.title.localeCompare(b.title, 'es') || a.externalId.localeCompare(b.externalId);
}
