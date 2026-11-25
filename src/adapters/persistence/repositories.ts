import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { JobRepository, SearchHistory, TaskRepository, WorkerRepository, WorkerSession } from '../../core/application/ports/persistence';
import { isDateOnly } from '../../core/domain/deadline';
import { requireCurrentPdfAndAvailableDelivery, requireDeliveryDestination } from '../../core/domain/delivery';
import {
  ApplicationError, CapturedAssignment, DeliveryEvidence, DeliveryState, JobView, SearchState, StoredPdf, TaskView,
} from '../../core/domain/model';
import * as schema from './schema';

const { tasks, pdfs, jobs, deliveries } = schema;
type Database = NodePgDatabase<typeof schema>;

export function postgresDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}

function jobView(job: typeof jobs.$inferSelect, delivery: typeof deliveries.$inferSelect | null): JobView {
  const base = { jobId: job.id, summary: job.summary };
  if (job.kind === 'search') return { ...base, kind: 'search', state: job.state as SearchState };
  const evidence = delivery?.observedActivityUrl && delivery.visibleStatus ? {
    activityUrl: delivery.observedActivityUrl, visibleStatus: delivery.visibleStatus,
    fileName: delivery.observedFileName ?? undefined, portalReference: delivery.portalReference ?? undefined,
  } : null;
  return { ...base, kind: 'delivery', state: job.state as DeliveryState, evidence, pdfId: delivery?.pdfId };
}

export class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly db: Database) {}

  list(accountId: string): Promise<TaskView[]> {
    return this.read(accountId);
  }

  async find(accountId: string, taskId: string): Promise<TaskView | null> {
    return (await this.read(accountId, taskId))[0] ?? null;
  }

  async attachPdf(accountId: string, taskId: string, pdf: StoredPdf): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [task] = await tx.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.accountId, accountId), eq(tasks.id, taskId))).for('update');
      if (!task) throw new ApplicationError('not_found', 'La tarea no existe.');
      await tx.update(pdfs).set({ current: false }).where(and(eq(pdfs.taskId, task.id), eq(pdfs.current, true)));
      await tx.insert(pdfs).values({
        id: pdf.pdfId, taskId: task.id, originalName: pdf.originalName, storageKey: pdf.storageKey,
        byteSize: pdf.sizeBytes, sha256: pdf.sha256, current: true,
      });
    });
  }

  private async read(accountId: string, taskId?: string): Promise<TaskView[]> {
    const rows = await this.db.select().from(tasks)
      .leftJoin(pdfs, and(eq(pdfs.taskId, tasks.id), eq(pdfs.current, true)))
      .leftJoinLateral(
        this.db.select({ jobId: deliveries.jobId })
          .from(deliveries).innerJoin(jobs, eq(jobs.id, deliveries.jobId))
          .where(eq(deliveries.taskId, tasks.id)).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1).as('latest'),
        sql`true`,
      )
      .leftJoin(jobs, eq(jobs.id, sql`latest.job_id`))
      .leftJoin(deliveries, eq(deliveries.jobId, jobs.id))
      .where(and(eq(tasks.accountId, accountId), taskId ? eq(tasks.id, taskId) : undefined));
    return rows.map(({ tasks: task, pdfs: pdf, jobs: job, deliveries: delivery }) => {
      const state = job && jobView(job, delivery);
      return {
        taskId: task.id, externalId: task.externalId, title: task.title, course: task.course,
        activityUrl: task.activityUrl, destination: task.destination,
        deadline: task.deadlineAt ? new Date(task.deadlineAt).toISOString() : task.deadlineDate,
        currentPdf: pdf ? { pdfId: pdf.id, originalName: pdf.originalName, sha256: pdf.sha256 } : null,
        delivery: state?.kind === 'delivery' ? state : null,
      };
    });
  }
}

export class PostgresJobRepository implements JobRepository, SearchHistory {
  constructor(private readonly db: Database) {}

  async queueSearch(accountId: string): Promise<string> {
    const [job] = await this.db.insert(jobs).values({ accountId, kind: 'search', state: 'queued' }).returning({ id: jobs.id });
    if (!job) throw new Error('No se registró la búsqueda.');
    return job.id;
  }

  async authorizeDelivery(accountId: string, taskId: string, pdfId: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [task] = await tx.select().from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.accountId, accountId))).for('update');
      if (!task) throw new ApplicationError('not_found', 'La tarea no existe.');

      const [existing] = await tx.select({ id: deliveries.jobId }).from(deliveries)
        .where(and(eq(deliveries.taskId, taskId), eq(deliveries.pdfId, pdfId)));
      if (existing) return existing.id;
      requireDeliveryDestination(task.destination);

      const [pdf] = await tx.select().from(pdfs)
        .where(and(eq(pdfs.taskId, taskId), eq(pdfs.id, pdfId), eq(pdfs.current, true)));
      const [pending] = await tx.select({ id: jobs.id }).from(deliveries)
        .innerJoin(jobs, eq(jobs.id, deliveries.jobId))
        .where(and(eq(deliveries.taskId, taskId), inArray(jobs.state, ['authorized', 'running', 'needs_verification'])))
        .limit(1);
      requireCurrentPdfAndAvailableDelivery(Boolean(pdf), Boolean(pending));
      if (!pdf) throw new Error('Falta el PDF vigente.');

      const [job] = await tx.insert(jobs).values({ accountId, kind: 'delivery', state: 'authorized' })
        .returning({ id: jobs.id });
      if (!job) throw new Error('No se registró el trabajo de entrega.');
      await tx.insert(deliveries).values({
        jobId: job.id, taskId, pdfId, externalId: task.externalId, activityUrl: task.activityUrl,
        originalName: pdf.originalName, storageKey: pdf.storageKey, sha256: pdf.sha256,
      });
      return job.id;
    });
  }

  async requestVerification(accountId: string, jobId: string): Promise<void> {
    const [job] = await this.db.update(jobs).set({ verifyRequested: true, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId), eq(jobs.state, 'needs_verification')))
      .returning({ id: jobs.id });
    if (!job) throw new ApplicationError('delivery_not_uncertain', 'La entrega no está por verificar.');
  }

  async latestSearch(accountId: string): Promise<Extract<JobView, { kind: 'search' }> | null> {
    const [job] = await this.db.select().from(jobs)
      .where(and(eq(jobs.accountId, accountId), eq(jobs.kind, 'search')))
      .orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1);
    const result = job ? jobView(job, null) : null;
    return result?.kind === 'search' ? result : null;
  }

  async find(accountId: string, jobId: string): Promise<JobView | null> {
    const [row] = await this.db.select().from(jobs).leftJoin(deliveries, eq(deliveries.jobId, jobs.id))
      .where(and(eq(jobs.id, jobId), eq(jobs.accountId, accountId)));
    return row ? jobView(row.jobs, row.deliveries) : null;
  }
}

export class PostgresWorkerRepository implements WorkerRepository {
  constructor(private readonly pool: Pool) {}

  async withAccountLock(accountId: string, run: (worker: WorkerSession) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    let destroyConnection = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended('fetcher-worker:' || $1, 0)) as locked", [accountId],
      );
      if (!result.rows[0]?.locked) return;
      try {
        await run(new PostgresWorkerSession(drizzle(client, { schema }), accountId));
      } finally {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock(hashtextextended('fetcher-worker:' || $1, 0)) as unlocked", [accountId],
        );
        destroyConnection = !unlocked.rows[0]?.unlocked;
      }
    } catch (error) {
      destroyConnection = true;
      throw error;
    } finally {
      client.release(destroyConnection);
    }
  }
}

class PostgresWorkerSession implements WorkerSession {
  constructor(private readonly db: Database, private readonly accountId: string) {}

  async recoverInterrupted(): Promise<void> {
    const running = and(eq(jobs.accountId, this.accountId), eq(jobs.state, 'running'));
    await this.db.transaction(async (tx) => {
      await tx.update(jobs).set({ state: 'queued', summary: null, updatedAt: sql`now()` })
        .where(and(running, eq(jobs.kind, 'search')));
      await tx.update(jobs)
        .set({ state: 'needs_verification', verifyRequested: true, summary: 'Entrega interrumpida.', updatedAt: sql`now()` })
        .where(and(running, eq(jobs.kind, 'delivery')));
    });
  }

  async claimNext() {
    return this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs)
        .where(and(eq(jobs.accountId, this.accountId), or(
          inArray(jobs.state, ['queued', 'authorized']),
          and(eq(jobs.state, 'needs_verification'), eq(jobs.verifyRequested, true)),
        )))
        .orderBy(jobs.createdAt, jobs.id).limit(1).for('update');
      if (!job) return null;
      const verify = job.state === 'needs_verification';
      await tx.update(jobs).set({
        state: verify ? 'needs_verification' : 'running', verifyRequested: false, updatedAt: sql`now()`,
      }).where(eq(jobs.id, job.id));
      if (job.kind === 'search') return { kind: 'search' as const, jobId: job.id };

      const [snapshot] = await tx.select().from(deliveries).where(eq(deliveries.jobId, job.id));
      if (!snapshot) throw new Error('Falta la orden persistida.');
      const { jobId, externalId, activityUrl, pdfId, originalName, sha256, storageKey } = snapshot;
      return {
        kind: verify ? 'verification' as const : 'delivery' as const,
        order: { jobId, accountId: this.accountId, externalId, activityUrl, pdfId, originalName, sha256, storageKey },
      };
    });
  }

  async completeSearch(jobId: string, assignments: CapturedAssignment[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const byId = new Map(assignments.map((task) => [task.externalId, task]));
      const rows = Array.from(byId.values(), ({ deadline, ...task }) => ({
        ...task, accountId: this.accountId,
        deadlineDate: deadline && isDateOnly(deadline) ? deadline : null,
        deadlineAt: deadline && !isDateOnly(deadline) ? deadline : null,
      }));
      if (rows.length) {
        await tx.insert(tasks).values(rows).onConflictDoUpdate({
          target: [tasks.accountId, tasks.externalId],
          set: {
            course: sql`excluded.course`, title: sql`excluded.title`, activityUrl: sql`excluded.activity_url`,
            destination: sql`excluded.destination`, deadlineDate: sql`excluded.deadline_date`,
            deadlineAt: sql`excluded.deadline_at`,
          },
        });
      }
      await tx.update(jobs).set({ state: 'completed', summary: 'Tareas actualizadas: ' + rows.length, updatedAt: sql`now()` })
        .where(and(eq(jobs.accountId, this.accountId), eq(jobs.id, jobId), eq(jobs.state, 'running')));
    });
  }

  async failSearch(jobId: string, summary: string): Promise<void> {
    await this.db.update(jobs).set({ state: 'failed', summary, updatedAt: sql`now()` })
      .where(and(eq(jobs.accountId, this.accountId), eq(jobs.id, jobId), eq(jobs.state, 'running')));
  }

  async settleDelivery(
    jobId: string, expected: 'running' | 'needs_verification',
    state: 'confirmed' | 'failed' | 'needs_verification', summary: string, evidence?: DeliveryEvidence,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [job] = await tx.update(jobs).set({
        state, summary, updatedAt: sql`now()`, verifyRequested: expected === 'running' && state === 'needs_verification',
      }).where(and(eq(jobs.accountId, this.accountId), eq(jobs.id, jobId), eq(jobs.state, expected))).returning({ id: jobs.id });
      if (job && evidence) {
        await tx.update(deliveries).set({
          observedActivityUrl: evidence.activityUrl, visibleStatus: evidence.visibleStatus,
          observedFileName: evidence.fileName ?? null, portalReference: evidence.portalReference ?? null,
        }).where(eq(deliveries.jobId, job.id));
      }
    });
  }
}
