import { isDateOnly } from './deadline';

export interface AgendaSortable {
  kind: 'task' | 'note';
  id: string;
  title: string;
  deadline: string | null;
  completed?: boolean;
}

function sortingTime(deadline: string | null): number {
  if (deadline === null) return Infinity;
  return Date.parse(isDateOnly(deadline) ? deadline + 'T23:59:59.999-05:00' : deadline);
}

export function compareAgendaItems(a: AgendaSortable, b: AgendaSortable): number {
  const aDone = a.completed ? 1 : 0;
  const bDone = b.completed ? 1 : 0;
  return aDone - bDone
    || sortingTime(a.deadline) - sortingTime(b.deadline)
    || a.title.localeCompare(b.title, 'es')
    || a.id.localeCompare(b.id);
}
