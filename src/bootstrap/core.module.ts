import { DynamicModule, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { AssignmentFetcher, AssignmentSender, ASSIGNMENT_FETCHER, ASSIGNMENT_SENDER } from '../core/application/ports/academic';
import {
  BuscarTareas, CargarPdf, ConsultarTrabajo, ConsultarUltimaBusqueda, ListarTareas, SolicitarEntrega, VerificarEntrega, VerTarea,
} from '../core/application/tasks';
import { ConsultarRevisionTareas } from '../core/application/assignment-import';
import { AcademicWorker } from '../core/application/worker';
import { LocalPdfStore } from '../adapters/persistence/files';
import {
  postgresDatabase, PostgresAssignmentImportRepository, PostgresJobRepository, PostgresTaskRepository, PostgresWorkerRepository,
} from '../adapters/persistence/repositories';
import { RuntimeConfig } from './config';
import { createSimulatedAcademic } from './dev-demo/simulated-academic';

const unavailableFetcher: AssignmentFetcher = { async fetch() { return { kind: 'unavailable' }; } };
const unavailableSender: AssignmentSender = {
  async submit() { return { state: 'failed' }; },
  async verify() { return { state: 'needs_verification' }; },
};

export const ACCOUNT_ID = Symbol('AccountId');

class WorkerLoop implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('AcademicWorker');
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;

  constructor(private readonly worker: AcademicWorker, private readonly pool: Pool, private readonly accountId: string, private readonly enabled: boolean) {
    pool.on('error', () => this.logger.warn('Se perdió una conexión de PostgreSQL.'));
  }

  onModuleInit() {
    if (this.enabled) this.poll();
  }

  private poll() {
    this.pending = this.worker.tick(this.accountId)
      .catch(() => this.logger.error('No se pudo procesar la cola. Se revisará en el siguiente ciclo.'))
      .then(() => {
        if (!this.stopped) this.timer = setTimeout(() => this.poll(), 400);
      });
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    await this.pool.end();
  }
}

@Module({})
export class CoreModule {
  static register(config: RuntimeConfig): DynamicModule {
    const demo = config.demoMode ? createSimulatedAcademic(config.accountId) : undefined;
    const exported = [ACCOUNT_ID, ASSIGNMENT_FETCHER, ASSIGNMENT_SENDER,
      BuscarTareas, ListarTareas, VerTarea, CargarPdf, SolicitarEntrega, ConsultarTrabajo, ConsultarUltimaBusqueda, ConsultarRevisionTareas, VerificarEntrega];

    return {
      module: CoreModule,
      providers: [
        { provide: ACCOUNT_ID, useValue: config.accountId },
        { provide: ASSIGNMENT_FETCHER, useValue: demo?.fetcher ?? unavailableFetcher },
        { provide: ASSIGNMENT_SENDER, useValue: demo?.sender ?? unavailableSender },
        { provide: Pool, useFactory: () => new Pool({ connectionString: config.databaseUrl }) },
        { provide: LocalPdfStore, useFactory: () => new LocalPdfStore(config.uploadDir) },
        {
          provide: PostgresTaskRepository, inject: [Pool],
          useFactory: (pool: Pool) => new PostgresTaskRepository(postgresDatabase(pool)),
        },
        {
          provide: PostgresJobRepository, inject: [Pool],
          useFactory: (pool: Pool) => new PostgresJobRepository(postgresDatabase(pool)),
        },
        {
          provide: ConsultarRevisionTareas, inject: [Pool],
          useFactory: (pool: Pool) => new ConsultarRevisionTareas(new PostgresAssignmentImportRepository(postgresDatabase(pool))),
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
          provide: WorkerLoop, inject: [Pool, ASSIGNMENT_FETCHER, ASSIGNMENT_SENDER, LocalPdfStore, ACCOUNT_ID],
          useFactory: (pool: Pool, fetcher: AssignmentFetcher, sender: AssignmentSender, files: LocalPdfStore, accountId: string) =>
            new WorkerLoop(new AcademicWorker(new PostgresWorkerRepository(pool), fetcher, sender, files), pool, accountId, !config.assistedCapture),
        },
      ],
      exports: exported,
    };
  }
}
