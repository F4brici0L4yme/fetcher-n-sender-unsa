import { PersonalNote } from '../../core/domain/personal-note';
import type { BadgeTone } from './panel.presenter';

const dateFormatter = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', year: 'numeric' });
const instantFormatter = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const priorityTones: Record<PersonalNote['priority'], BadgeTone> = {
  alta: 'danger',
  media: 'warning',
  baja: 'success',
};

export function presentNote(note: PersonalNote) {
  return {
    ...note,
    kind: 'note' as const,
    isNote: true,
    href: '/notas/' + note.noteId,
    completed: note.status === 'completado',
    priorityLabel: { alta: 'Alta', media: 'Media', baja: 'Baja' }[note.priority],
    priorityTone: priorityTones[note.priority],
    deadlineLabel: note.deadline === null ? 'Sin fecha' : note.deadline.length === 10
      ? dateFormatter.format(new Date(note.deadline + 'T12:00:00-05:00'))
      : instantFormatter.format(new Date(note.deadline)) + ' (Lima)',
  };
}

export function noteFormValues(input: unknown) {
  const fields = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const priority = typeof fields.priority === 'string' ? fields.priority : 'media';
  const status = typeof fields.status === 'string' ? fields.status : 'pendiente';
  return {
    title: typeof fields.title === 'string' ? fields.title : '',
    description: typeof fields.description === 'string' ? fields.description : '',
    deadline: typeof fields.deadline === 'string' ? fields.deadline : '',
    high: priority === 'alta', medium: priority === 'media', low: priority === 'baja',
    pending: status === 'pendiente', completed: status === 'completado',
  };
}
