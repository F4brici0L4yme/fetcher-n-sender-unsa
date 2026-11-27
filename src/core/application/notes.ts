import { ApplicationError } from '../domain/model';
import { PersonalNote, validateNote } from '../domain/personal-note';
import { NoteRepository } from './ports/notes';

export class PersonalNotes {
  constructor(private readonly notes: NoteRepository) {}
  list(accountId: string): Promise<PersonalNote[]> {
    return this.notes.list(accountId);
  }

  async find(accountId: string, noteId: string): Promise<PersonalNote> {
    return this.requireFound(await this.notes.find(accountId, noteId));
  }

  async create(accountId: string, input: unknown): Promise<PersonalNote> {
    return this.notes.create(accountId, validateNote(input));
  }

  async update(accountId: string, noteId: string, input: unknown): Promise<PersonalNote> {
    return this.requireFound(await this.notes.update(accountId, noteId, validateNote(input)));
  }

  async complete(accountId: string, noteId: string): Promise<PersonalNote> {
    return this.requireFound(await this.notes.complete(accountId, noteId));
  }

  async remove(accountId: string, noteId: string): Promise<void> {
    if (!await this.notes.remove(accountId, noteId)) throw this.notFound();
  }

  private requireFound(note: PersonalNote | null): PersonalNote {
    if (!note) throw this.notFound();
    return note;
  }

  private notFound(): ApplicationError {
    return new ApplicationError('not_found', 'La nota no existe.');
  }
}
