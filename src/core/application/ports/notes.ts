import { NoteFields, PersonalNote } from '../../domain/personal-note';

export interface NoteRepository {
  list(accountId: string): Promise<PersonalNote[]>;
  find(accountId: string, noteId: string): Promise<PersonalNote | null>;
  create(accountId: string, fields: NoteFields): Promise<PersonalNote>;
  update(accountId: string, noteId: string, fields: NoteFields): Promise<PersonalNote | null>;
  complete(accountId: string, noteId: string): Promise<PersonalNote | null>;
  remove(accountId: string, noteId: string): Promise<boolean>;
}
