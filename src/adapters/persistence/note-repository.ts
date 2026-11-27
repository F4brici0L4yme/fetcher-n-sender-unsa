import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { NoteRepository } from '../../core/application/ports/notes';
import { NoteFields, PersonalNote } from '../../core/domain/personal-note';
import * as schema from './schema';
import { isDateOnly } from '../../core/domain/deadline';
import { personalNotes } from './schema-notes';

function present(row: typeof personalNotes.$inferSelect): PersonalNote {
  return {
    noteId: row.id, accountId: row.accountId, title: row.title, description: row.description,
    priority: row.priority, status: row.status,
    deadline: row.deadlineAt ? new Date(row.deadlineAt).toISOString() : row.deadlineDate,
  };
}

function values({ deadline, ...fields }: NoteFields) {
  return {
    ...fields,
    deadlineDate: deadline && isDateOnly(deadline) ? deadline : null,
    deadlineAt: deadline && !isDateOnly(deadline) ? deadline : null,
  };
}

export class PostgresNoteRepository implements NoteRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}
  async list(accountId: string): Promise<PersonalNote[]> {
    return (await this.db.select().from(personalNotes).where(eq(personalNotes.accountId, accountId))).map(present);
  }

  async find(accountId: string, noteId: string): Promise<PersonalNote | null> {
    const [row] = await this.db.select().from(personalNotes).where(this.owned(accountId, noteId));
    return row ? present(row) : null;
  }

  async create(accountId: string, fields: NoteFields): Promise<PersonalNote> {
    const [row] = await this.db.insert(personalNotes).values({ accountId, ...values(fields) }).returning();
    if (!row) throw new Error('No se pudo guardar la nota.');
    return present(row);
  }

  async update(accountId: string, noteId: string, fields: NoteFields): Promise<PersonalNote | null> {
    const [row] = await this.db.update(personalNotes).set({ ...values(fields), updatedAt: new Date().toISOString() })
      .where(this.owned(accountId, noteId)).returning();
    return row ? present(row) : null;
  }

  async complete(accountId: string, noteId: string): Promise<PersonalNote | null> {
    const [row] = await this.db.update(personalNotes).set({ status: 'completado', updatedAt: new Date().toISOString() })
      .where(this.owned(accountId, noteId)).returning();
    return row ? present(row) : null;
  }

  async remove(accountId: string, noteId: string): Promise<boolean> {
    const rows = await this.db.delete(personalNotes).where(this.owned(accountId, noteId)).returning({ id: personalNotes.id });
    return rows.length !== 0;
  }

  private owned(accountId: string, noteId: string) {
    return and(eq(personalNotes.accountId, accountId), eq(personalNotes.id, noteId));
  }
}
