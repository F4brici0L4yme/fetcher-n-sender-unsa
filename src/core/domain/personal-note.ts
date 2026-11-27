export type NotePriority = 'alta' | 'media' | 'baja';
export type NoteStatus = 'pendiente' | 'completado';

export interface NoteFields {
  title: string;
  description: string;
  priority: NotePriority;
  deadline: string | null;
  status: NoteStatus;
}

export interface PersonalNote extends NoteFields {
  noteId: string;
  accountId: string;
}

export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteValidationError';
  }
}

export function validateNote(input: unknown): NoteFields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new NoteValidationError('La nota debe contener campos válidos.');
  }
  const fields = input as Record<string, unknown>;
  if (typeof fields.title !== 'string' || !fields.title.trim() || fields.title.trim().length > 200) {
    throw new NoteValidationError('El título debe tener entre 1 y 200 caracteres.');
  }
  const description = fields.description === undefined ? '' : fields.description;
  if (typeof description !== 'string' || description.length > 10000) {
    throw new NoteValidationError('La descripción debe tener como máximo 10000 caracteres.');
  }
  const priority = fields.priority;
  if (priority !== 'alta' && priority !== 'media' && priority !== 'baja') {
    throw new NoteValidationError('La prioridad debe ser alta, media o baja.');
  }
  const status = fields.status === undefined ? 'pendiente' : fields.status;
  if (status !== 'pendiente' && status !== 'completado') {
    throw new NoteValidationError('El estado debe ser pendiente o completado.');
  }
  const rawDeadline = fields.deadline;
  if (rawDeadline !== undefined && rawDeadline !== null && typeof rawDeadline !== 'string') {
    throw new NoteValidationError('La fecha debe ser una fecha válida o quedar vacía.');
  }
  let deadline: string | null;
  try {
    deadline = normalizeDeadline(rawDeadline === undefined || rawDeadline === '' ? null : rawDeadline);
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    throw new NoteValidationError('La fecha de la nota no es válida. Incluye la zona horaria si indicas una hora.');
  }
  return { title: fields.title.trim(), description, priority, deadline, status };
}
import { normalizeDeadline } from './deadline';
import { ApplicationError } from './model';

