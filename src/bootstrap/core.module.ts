import { DynamicModule, Logger, Module, OnApplicationShutdown, OnModuleInit, type Provider } from '@nestjs/common';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  AnalizarComandoEntrega, AutorizarPropuestaAgente, ConsultarCapturaEntrega, ListarPropuestasAgente,
  PoliticaAutomatizacion, PrepararEntregaAgente, RechazarPropuestaAgente,
} from '../core/application/agent';
import { AssignmentFetcher, AssignmentSender, ASSIGNMENT_FETCHER, ASSIGNMENT_SENDER } from '../core/application/ports/academic';
import { AUTO_SYNC_MONITOR, type AutoSyncMonitor } from '../core/application/ports/agent';
import { PERSONAL_SESSION, type PersonalSession } from '../core/application/ports/browser-session';
import {
  BuscarTareas, CargarPdf, ConsultarTrabajo, ConsultarUltimaBusqueda, DescartarIntentoEntrega, ListarTareas, SolicitarEntrega, VerificarEntrega, VerTarea,
} from '../core/application/tasks';
import { ConsultarRevisionCuenta, ConsultarRevisionTareas } from '../core/application/assignment-import';
import { PersonalNotes } from '../core/application/notes';
import { AcademicWorker } from '../core/application/worker';
import { type AutoSyncStatus } from '../core/domain/agent-automation';
import { ContainerLoginViewer } from '../adapters/browser/login-viewer';
import { PersonalBrowser } from '../adapters/browser/personal-browser';
import { PostgresAgentAutomationRepository } from '../adapters/persistence/agent-repository';
import { LocalPdfStore, LocalProofStore } from '../adapters/persistence/files';
import { PostgresNoteRepository } from '../adapters/persistence/note-repository';
import {
  postgresDatabase, PostgresAccountRevisionRepository, PostgresAssignmentImportRepository, PostgresJobRepository, PostgresTaskRepository, PostgresWorkerRepository,
} from '../adapters/persistence/repositories';
import { RuntimeConfig } from './config';
import { createSimulatedAcademic } from './dev-demo/simulated-academic';

const unavailableFetcher: AssignmentFetcher = { async fetch() { return { kind: 'unavailable' }; } };
const unavailableSender: AssignmentSender = {
  async submit() { return { state: 'failed' }; },
  async verify() { return { state: 'needs_verification' }; },
};

export const ACCOUNT_ID = Symbol('AccountId');

class WorkerLoop implements OnModuleInit, OnApplicationShutdown, AutoSyncMonitor {
  private readonly logger = new Logger('AcademicWorker');
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private lastConnectedAccount: string | null = null;
  private lastSyncAt: string | null = null;
  private nextSyncMs = 0;
  private syncRunning = false;

  constructor(
    private readonly worker: AcademicWorker,
    private readonly pool: Pool,
    private readonly account: string | PersonalSession,
    private readonly enabled: boolean,
    private readonly search: BuscarTareas,
    private readonly latestSearch: ConsultarUltimaBusqueda,
    private readonly autoSyncIntervalSeconds: number,
    private readonly browser?: PersonalBrowser,
  ) {
    pool.on('error', () => this.logger.warn('Se perdió una conexión de PostgreSQL.'));
  }

  status(): AutoSyncStatus {
    const enabled = this.enabled && Boolean(this.browser) && this.autoSyncIntervalSeconds > 0;
    return {
      enabled,
      intervalSeconds: enabled ? this.autoSyncIntervalSeconds : 0,
      lastSyncAt: this.lastSyncAt,
      nextSyncAt: enabled && this.nextSyncMs > 0 ? new Date(this.nextSyncMs).toISOString() : null,
      running: this.syncRunning,
    };
  }

  async onModuleInit() {
    if (this.browser) await this.browser.initialize();
    if (this.enabled) this.poll();
  }

  private async maybeScheduleAutoSync() {
    if (!this.enabled || !this.browser || this.autoSyncIntervalSeconds <= 0) return;
    const state = await this.browser.status();
    if (state.state !== 'connected') {
      this.lastConnectedAccount = null;
      this.nextSyncMs = 0;
      this.syncRunning = false;
      return;
    }
    if (state.busy) return;

    const now = Date.now();
    const justConnected = this.lastConnectedAccount !== state.accountId;
    const due = this.nextSyncMs > 0 && now >= this.nextSyncMs;
    if (!justConnected && !due) return;

    const latest = await this.latestSearch.execute(state.accountId);
    if (latest && (latest.state === 'queued' || latest.state === 'running')) {
      this.lastConnectedAccount = state.accountId;
      this.nextSyncMs = now + this.autoSyncIntervalSeconds * 1000;
      this.syncRunning = true;
      return;
    }

    this.lastConnectedAccount = state.accountId;
    this.syncRunning = true;
    await this.search.execute(state.accountId);
    const stamp = Date.now();
    this.lastSyncAt = new Date(stamp).toISOString();
    this.nextSyncMs = stamp + this.autoSyncIntervalSeconds * 1000;
  }

  private poll() {
    const accountId = typeof this.account === 'string' ? this.account : this.account.current();
    this.pending = (async () => {
      await this.maybeScheduleAutoSync();
      await this.worker.tick(accountId);
      if (this.syncRunning) {
        const latest = await this.latestSearch.execute(accountId).catch(() => null);
        if (!latest || (latest.state !== 'queued' && latest.state !== 'running')) {
          this.syncRunning = false;
          if (latest?.state === 'completed') {
            this.lastSyncAt = new Date().toISOString();
          }
        }
      }
    })()
      .catch(() => this.logger.error('No se pudo procesar la cola. Se revisará en el siguiente ciclo.'))
      .then(() => {
        if (!this.stopped) this.timer = setTimeout(() => this.poll(), 400);
      });
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    await this.browser?.close();
    await this.pool.end();
  }
}

@Module({})
export class CoreModule {
  static register(config: RuntimeConfig): DynamicModule {
    const demo = config.demoMode ? createSimulatedAcademic(config.accountId) : undefined;
    const hasPersonalBrowser = Boolean(config.personalBrowser);
    const proofDir = config.proofDir ?? resolve(config.uploadDir, 'proofs');
    const autoSyncSeconds = config.autoSyncIntervalSeconds ?? (hasPersonalBrowser ? 180 : 0);
    const exported = [
      ACCOUNT_ID, ASSIGNMENT_FETCHER, ASSIGNMENT_SENDER, AUTO_SYNC_MONITOR,
      BuscarTareas, ListarTareas, VerTarea, CargarPdf, SolicitarEntrega,
      ConsultarTrabajo, ConsultarUltimaBusqueda, ConsultarRevisionTareas, ConsultarRevisionCuenta,
      VerificarEntrega, DescartarIntentoEntrega, PersonalNotes,
      PoliticaAutomatizacion, ListarPropuestasAgente, AnalizarComandoEntrega,
      PrepararEntregaAgente, AutorizarPropuestaAgente, RechazarPropuestaAgente, ConsultarCapturaEntrega,
      ...(hasPersonalBrowser ? [PERSONAL_SESSION] : []),
    ];

    const browserProviders: Provider[] = config.personalBrowser ? [
      {
        provide: PersonalBrowser, inject: [Pool, LocalProofStore],
        useFactory: (pool: Pool, proofStore: LocalProofStore) => new PersonalBrowser(pool, {
          portalUrl: config.personalBrowser!.portalUrl,
          profileDir: config.personalBrowser!.profileDir,
          accountNamespace: config.personalBrowser!.accountNamespace,
          initialAccountId: config.accountId,
          initialPortalAccount: config.personalBrowser!.portalAccount,
          executablePath: config.personalBrowser!.executablePath,
          proofStore,
          viewer: new ContainerLoginViewer({
            display: config.personalBrowser!.display,
            port: 6080,
            hostPort: config.personalBrowser!.viewerPort,
          }),
        }),
      },
      { provide: PERSONAL_SESSION, useExisting: PersonalBrowser },
      { provide: ACCOUNT_ID, useExisting: PersonalBrowser },
      { provide: ASSIGNMENT_FETCHER, useExisting: PersonalBrowser },
      { provide: ASSIGNMENT_SENDER, useExisting: PersonalBrowser },
    ] : [
      { provide: ACCOUNT_ID, useValue: config.accountId },
      { provide: ASSIGNMENT_FETCHER, useValue: demo?.fetcher ?? unavailableFetcher },
      { provide: ASSIGNMENT_SENDER, useValue: demo?.sender ?? unavailableSender },
    ];

    return {
      module: CoreModule,
      providers: [
        { provide: Pool, useFactory: () => new Pool({ connectionString: config.databaseUrl }) },
        { provide: LocalPdfStore, useFactory: () => new LocalPdfStore(config.uploadDir) },
        { provide: LocalProofStore, useFactory: () => new LocalProofStore(proofDir) },
        ...browserProviders,
        {
          provide: PostgresTaskRepository, inject: [Pool],
          useFactory: (pool: Pool) => new PostgresTaskRepository(postgresDatabase(pool)),
        },
        {
          provide: PostgresJobRepository, inject: [Pool],
          useFactory: (pool: Pool) => new PostgresJobRepository(postgresDatabase(pool)),
        },
        {
          provide: PostgresNoteRepository, inject: [Pool],
          useFactory: (pool: Pool) => new PostgresNoteRepository(postgresDatabase(pool)),
        },
        {
          provide: PostgresAgentAutomationRepository, inject: [Pool],
          useFactory: (pool: Pool) => new PostgresAgentAutomationRepository(postgresDatabase(pool)),
        },
        {
          provide: PersonalNotes, inject: [PostgresNoteRepository],
          useFactory: (notes: PostgresNoteRepository) => new PersonalNotes(notes),
        },
        {
          provide: ConsultarRevisionTareas, inject: [Pool],
          useFactory: (pool: Pool) => new ConsultarRevisionTareas(new PostgresAssignmentImportRepository(postgresDatabase(pool))),
        },
        {
          provide: ConsultarRevisionCuenta, inject: [Pool],
          useFactory: (pool: Pool) => new ConsultarRevisionCuenta(new PostgresAccountRevisionRepository(postgresDatabase(pool))),
        },
        { provide: BuscarTareas, inject: [PostgresJobRepository], useFactory: (jobs: PostgresJobRepository) => new BuscarTareas(jobs) },
        { provide: ListarTareas, inject: [PostgresTaskRepository], useFactory: (tasks: PostgresTaskRepository) => new ListarTareas(tasks) },
        { provide: VerTarea, inject: [PostgresTaskRepository], useFactory: (tasks: PostgresTaskRepository) => new VerTarea(tasks) },
        {
          provide: CargarPdf, inject: [PostgresTaskRepository, LocalPdfStore],
          useFactory: (tasks: PostgresTaskRepository, files: LocalPdfStore) => new CargarPdf(tasks, files),
        },
        { provide: SolicitarEntrega, inject: [PostgresJobRepository], useFactory: (jobs: PostgresJobRepository) => new SolicitarEntrega(jobs) },
        {
          provide: ConsultarUltimaBusqueda, inject: [PostgresJobRepository],
          useFactory: (jobs: PostgresJobRepository) => new ConsultarUltimaBusqueda(jobs),
        },
        { provide: ConsultarTrabajo, inject: [PostgresJobRepository], useFactory: (jobs: PostgresJobRepository) => new ConsultarTrabajo(jobs) },
        { provide: VerificarEntrega, inject: [PostgresJobRepository], useFactory: (jobs: PostgresJobRepository) => new VerificarEntrega(jobs) },
        {
          provide: DescartarIntentoEntrega, inject: [PostgresJobRepository, LocalProofStore],
          useFactory: (jobs: PostgresJobRepository, proofs: LocalProofStore) => new DescartarIntentoEntrega(jobs, proofs),
        },
        {
          provide: PoliticaAutomatizacion, inject: [PostgresAgentAutomationRepository],
          useFactory: (repo: PostgresAgentAutomationRepository) => new PoliticaAutomatizacion(repo),
        },
        {
          provide: ListarPropuestasAgente, inject: [PostgresAgentAutomationRepository],
          useFactory: (repo: PostgresAgentAutomationRepository) => new ListarPropuestasAgente(repo),
        },
        {
          provide: AnalizarComandoEntrega, inject: [ListarTareas],
          useFactory: (list: ListarTareas) => new AnalizarComandoEntrega(list),
        },
        {
          provide: PrepararEntregaAgente, inject: [ListarTareas, CargarPdf, SolicitarEntrega, PostgresAgentAutomationRepository],
          useFactory: (list: ListarTareas, loadPdf: CargarPdf, deliver: SolicitarEntrega, repo: PostgresAgentAutomationRepository) =>
            new PrepararEntregaAgente(list, loadPdf, deliver, repo),
        },
        {
          provide: AutorizarPropuestaAgente, inject: [PostgresAgentAutomationRepository, SolicitarEntrega],
          useFactory: (repo: PostgresAgentAutomationRepository, deliver: SolicitarEntrega) =>
            new AutorizarPropuestaAgente(repo, deliver),
        },
        {
          provide: RechazarPropuestaAgente, inject: [PostgresAgentAutomationRepository],
          useFactory: (repo: PostgresAgentAutomationRepository) => new RechazarPropuestaAgente(repo),
        },
        {
          provide: ConsultarCapturaEntrega, inject: [ConsultarTrabajo, LocalProofStore],
          useFactory: (jobs: ConsultarTrabajo, proofs: LocalProofStore) => new ConsultarCapturaEntrega(jobs, proofs),
        },
        {
          provide: WorkerLoop,
          inject: hasPersonalBrowser
            ? [Pool, ASSIGNMENT_FETCHER, ASSIGNMENT_SENDER, LocalPdfStore, ACCOUNT_ID, BuscarTareas, ConsultarUltimaBusqueda, PersonalBrowser]
            : [Pool, ASSIGNMENT_FETCHER, ASSIGNMENT_SENDER, LocalPdfStore, ACCOUNT_ID, BuscarTareas, ConsultarUltimaBusqueda],
          useFactory: (
            pool: Pool, fetcher: AssignmentFetcher, sender: AssignmentSender, files: LocalPdfStore,
            account: string | PersonalSession, search: BuscarTareas, latestSearch: ConsultarUltimaBusqueda,
            browser?: PersonalBrowser,
          ) => new WorkerLoop(
            new AcademicWorker(new PostgresWorkerRepository(pool), fetcher, sender, files),
            pool, account, !config.assistedCapture, search, latestSearch, autoSyncSeconds, browser,
          ),
        },
        { provide: AUTO_SYNC_MONITOR, useExisting: WorkerLoop },
      ],
      exports: exported,
    };
  }
}
