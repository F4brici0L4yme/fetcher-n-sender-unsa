import { Client } from 'pg';
import { TaskChanges } from '../../core/application/ports/persistence';

export const TASK_CHANGES_CHANNEL = 'fetcher_tasks_changed';

export class PostgresTaskChanges implements TaskChanges {
  private readonly listeners = new Set<{ onChange: () => void; onClose: () => void }>();
  private client?: Client;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly databaseUrl: string, private readonly accountId: string | { current(): string }) {}

  private currentAccount(): string {
    return typeof this.accountId === 'string' ? this.accountId : this.accountId.current();
  }

  subscribe(onChange: () => void, onClose: () => void): () => void {
    if (this.closed) {
      onClose();
      return () => {};
    }
    const listener = { onChange, onClose };
    this.listeners.add(listener);
    if (!this.client && !this.retry && !this.closed) this.connect();
    return () => { this.listeners.delete(listener); };
  }

  private connect(): void {
    const client = new Client({ connectionString: this.databaseUrl, connectionTimeoutMillis: 3000 });
    this.client = client;
    const lostConnection = () => {
      if (this.closed || this.client !== client) return;
      this.client = undefined;
      void client.end().catch(() => {});
      this.retry = setTimeout(() => {
        this.retry = undefined;
        if (!this.closed && this.listeners.size) this.connect();
      }, 1000);
    };
    client.on('error', lostConnection);
    client.on('end', lostConnection);
    client.on('notification', ({ channel, payload }) => {
      if (channel === TASK_CHANGES_CHANNEL && (payload === this.currentAccount() || typeof this.accountId !== 'string')) {
        this.signal();
      }
    });
    void client.connect()
      .then(() => client.query('LISTEN ' + TASK_CHANGES_CHANNEL))
      // An import could have committed before LISTEN became active.
      .then(() => this.signal(), lostConnection);
  }

  private signal(): void {
    for (const listener of this.listeners) listener.onChange();
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    for (const listener of this.listeners) listener.onClose();
    this.listeners.clear();
    const client = this.client;
    this.client = undefined;
    await client?.end();
  }
}
