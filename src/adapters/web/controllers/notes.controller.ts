import {
  Body, Controller, Get, Header, Inject, NotFoundException, Optional, Param, ParseUUIDPipe, Post, Render, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ListarPropuestasAgente, PoliticaAutomatizacion } from '../../../core/application/agent';
import { PersonalNotes } from '../../../core/application/notes';
import { AUTO_SYNC_MONITOR, type AutoSyncMonitor } from '../../../core/application/ports/agent';
import { PERSONAL_SESSION, type PersonalSession } from '../../../core/application/ports/browser-session';
import { ListarTareas } from '../../../core/application/tasks';
import { ApplicationError } from '../../../core/domain/model';
import { NoteValidationError } from '../../../core/domain/personal-note';
import { noteFormValues } from '../notes.presenter';
import { assertCurrentAccount, currentAccount, type PanelAccount } from '../panel-account';
import { presentAutoSync, presentSession, presentSidebar } from '../panel.presenter';
import { PANEL_ACCOUNT } from '../panel.tokens';
import { PanelWriteGuard } from '../panel-write.guard';

@Controller('notas')
@UseGuards(PanelWriteGuard)
export class NotesController {
  constructor(
    @Optional() private readonly notes?: PersonalNotes,
    @Inject(PANEL_ACCOUNT) private readonly account: PanelAccount = '',
    @Optional() @Inject(PERSONAL_SESSION) private readonly session?: PersonalSession,
    @Optional() private readonly list?: ListarTareas,
    @Optional() private readonly proposals?: ListarPropuestasAgente,
    @Optional() private readonly policy?: PoliticaAutomatizacion,
    @Optional() @Inject(AUTO_SYNC_MONITOR) private readonly autoSync?: AutoSyncMonitor,
  ) {}

  @Get('nueva')
  @Header('Cache-Control', 'no-store')
  @Render('panel-note')
  async createForm() {
    this.requireNotes();
    const accountId = currentAccount(this.account);
    return {
      accountId,
      form: noteFormValues({}),
      sidebar: await this.buildSidebar(accountId),
    };
  }

  @Get(':noteId')
  @Header('Cache-Control', 'no-store')
  @Render('panel-note')
  async edit(@Param('noteId', ParseUUIDPipe) noteId: string) {
    const notes = this.requireNotes();
    const accountId = currentAccount(this.account);
    try {
      const [note, sidebar] = await Promise.all([
        notes.find(accountId, noteId),
        this.buildSidebar(accountId),
      ]);
      return { accountId, noteId, form: noteFormValues(note), sidebar };
    } catch (error) { this.translate(error); }
  }

  @Post()
  async create(@Body() body: unknown, @Res() response: Response) {
    const notes = this.requireNotes();
    const accountId = this.pinnedAccount(body);
    try {
      await notes.create(accountId, body);
      response.redirect(303, '/');
    } catch (error) { await this.respond(error, response, body, accountId); }
  }

  @Post(':noteId/editar')
  async update(@Param('noteId', ParseUUIDPipe) noteId: string, @Body() body: unknown, @Res() response: Response) {
    const notes = this.requireNotes();
    const accountId = this.pinnedAccount(body);
    try {
      await notes.update(accountId, noteId, body);
      response.redirect(303, '/');
    } catch (error) { await this.respond(error, response, body, accountId, noteId); }
  }

  @Post(':noteId/completar')
  async complete(@Param('noteId', ParseUUIDPipe) noteId: string, @Body() body: unknown, @Res() response: Response) {
    const notes = this.requireNotes();
    const accountId = this.pinnedAccount(body);
    try {
      await notes.complete(accountId, noteId);
      response.redirect(303, '/');
    } catch (error) { this.translate(error); }
  }

  @Post(':noteId/eliminar')
  async remove(@Param('noteId', ParseUUIDPipe) noteId: string, @Body() body: unknown, @Res() response: Response) {
    const notes = this.requireNotes();
    const accountId = this.pinnedAccount(body);
    try {
      await notes.remove(accountId, noteId);
      response.redirect(303, '/');
    } catch (error) { this.translate(error); }
  }

  private async buildSidebar(accountId: string) {
    const [tasks, noteList, sessionStatus, proposalList] = await Promise.all([
      this.list ? this.list.execute(accountId) : Promise.resolve(null),
      this.notes ? this.notes.list(accountId) : Promise.resolve(null),
      this.session ? this.session.status() : Promise.resolve(null),
      this.proposals ? this.proposals.execute(accountId, 20) : Promise.resolve(null),
    ]);
    const session = presentSession(sessionStatus);
    const autoSync = presentAutoSync(this.autoSync?.status());
    const completedCount = (noteList ? noteList.filter((n) => n.status === 'completado').length : 0)
      + (tasks ? tasks.filter((t) => t.delivery?.state === 'confirmed').length : 0);

    return presentSidebar({
      active: 'notas',
      notesEnabled: Boolean(this.notes),
      agentEnabled: Boolean(this.policy),
      session,
      autoSync,
      liveActive: false,
      counts: {
        tasks: tasks ? tasks.filter((t) => t.delivery?.state !== 'confirmed').length : undefined,
        notes: noteList ? noteList.filter((n) => n.status !== 'completado').length : undefined,
        completed: tasks || noteList ? completedCount : undefined,
        proposals: proposalList ? proposalList.filter((p) => p.state === 'pending').length : undefined,
      },
    });
  }

  private requireNotes(): PersonalNotes {
    if (!this.notes) throw new NotFoundException('Las notas personales no están habilitadas.');
    return this.notes;
  }

  private pinnedAccount(body: unknown): string {
    const submitted = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).accountId : undefined;
    assertCurrentAccount(this.account, submitted);
    return currentAccount(this.account);
  }

  private async respond(error: unknown, response: Response, body: unknown, accountId: string, noteId?: string): Promise<void> {
    if (error instanceof NoteValidationError) {
      response.status(400).render('panel-note', {
        accountId,
        noteId,
        form: noteFormValues(body),
        error: error.message,
        sidebar: await this.buildSidebar(accountId),
      });
      return;
    }
    this.translate(error);
  }

  private translate(error: unknown): never {
    if (error instanceof ApplicationError && error.code === 'not_found') throw new NotFoundException(error.message);
    throw error;
  }
}
