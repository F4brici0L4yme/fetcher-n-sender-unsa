import { chromium, type BrowserContext } from 'playwright';
import type { Pool, PoolClient } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PersonalSession } from '../../core/application/ports/browser-session';
import type { ProofStore } from '../../core/application/ports/persistence';
import type { BrowserSessionState, BrowserSessionStatus, BrowserViewerAccess } from '../../core/domain/browser-session';
import { BrowserSessionError } from '../../core/domain/browser-session';
import type { CaptureResult, DeliveryOrder, DeliveryResult } from '../../core/domain/model';
import { PostgresBrowserSessionRepository } from '../persistence/browser-session-repository';
import { AulaVirtualFetcher, normalizeAulaPortalUrl } from '../fetcher/aula-virtual';
import { AulaVirtualSender } from '../sender/aula-virtual-sender';
import type { AulaVirtualDeliveryBrowser, DeliveryPageEditor, DeliveryPageObservation, DeliveryTarget } from '../sender/aula-virtual-delivery-browser';
import { accountKey, normalizeIdentity } from './security';
import { eraseProfile, protectedProfile, authorizedPdf } from './profiles';
import { restorePortalCookies, savePortalCookies } from './cookies';
import { captureAssignments, IdentityMismatch, MoodleDeliveryPage, secureContext, SessionExpired, verifyIdentity } from './moodle';

export interface LoginViewer { start(): Promise<void>; stop(): Promise<void>; access?(): BrowserViewerAccess | null; }
export interface PersonalBrowserOptions {
  portalUrl: string; profileDir: string; accountNamespace: string; initialAccountId: string;
  initialPortalAccount?: string; executablePath?: string; viewer?: LoginViewer; proofStore?: ProofStore;
}
export interface BrowserDependencies {
  launch?: (profile: string, headless: boolean) => Promise<BrowserContext>;
  loginTimeoutMs?: number; loginPollMs?: number;
}

const messages: Record<BrowserSessionState, string> = {
  disconnected: 'Conecta tu sesión de Aula Virtual.', connecting: 'Inicia sesión manualmente en el navegador de conexión.',
  connected: 'Sesión conectada. Las operaciones se ejecutan en segundo plano.', expired: 'Tu sesión venció. Vuelve a conectarla.',
  error: 'No se pudo verificar la sesión o la cuenta no coincide. Desconecta y vuelve a iniciar sesión.',
};

export class PersonalBrowser implements PersonalSession {
  private readonly repository: PostgresBrowserSessionRepository;
  private readonly portal: string;
  private active: string;
  private identity = '';
  private state: BrowserSessionState = 'disconnected';
  private busy = false;
  private ready = false;
  private closing = false;
  private cancelled = false;
  private lock?: PoolClient;
  private context?: BrowserContext;
  private profile?: string;
  private login?: Promise<void>;

  constructor(private readonly pool: Pool, private readonly options: PersonalBrowserOptions, private readonly dependencies: BrowserDependencies = {}) {
    this.repository = new PostgresBrowserSessionRepository(pool);
    this.portal = normalizeAulaPortalUrl(options.portalUrl);
    this.active = options.initialAccountId;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtextextended('personal-browser:active',0)) as locked");
      if (!result.rows[0]?.locked) throw new BrowserSessionError('browser_busy', 'Ya existe una instancia con esta sesión personal.');
      this.lock = client;
      client.on('error', () => {
        this.ready = false; this.state = 'error'; this.cancelled = true;
        void this.context?.close().catch(() => undefined);
      });
      const persisted = await this.repository.active();
      if (persisted) {
        this.active = persisted.accountId;
        this.identity = normalizeIdentity(persisted.expectedIdentity);
        this.state = persisted.state as BrowserSessionState;
        if (this.state === 'connecting') await this.setState('expired');
      }
      this.ready = true;
    } catch (error) {
      client.release(true); this.lock = undefined;
      throw error;
    }
  }

  current(): string { return this.active; }
  async status(): Promise<BrowserSessionStatus> {
    return {
      accountId: this.active, state: this.state, busy: this.busy, message: messages[this.state],
      viewer: this.state === 'connecting' ? (this.options.viewer?.access?.() ?? null) : null,
    };
  }

  private ensureReady() {
    if (!this.ready || this.closing) throw new BrowserSessionError('browser_unavailable', 'El navegador personal no está disponible.');
    if (this.busy) throw new BrowserSessionError('browser_busy', 'Espera a que termine la operación actual.');
  }

  async connect(expectedIdentity: string): Promise<BrowserSessionStatus> {
    this.ensureReady();
    const identity = normalizeIdentity(expectedIdentity);
    const account = accountKey(this.options.accountNamespace, this.portal, identity);
    if (this.state === 'connected' || (this.identity && this.active !== account && this.state !== 'disconnected')) {
      throw new BrowserSessionError('browser_busy', 'Desconecta la cuenta actual antes de iniciar otra sesión.');
    }
    this.busy = true; this.cancelled = false;
    try {
      await this.options.viewer?.start();
      await this.repository.select(account, identity, 'connecting');
      this.active = account; this.identity = identity; this.state = 'connecting';
      this.login = this.loginManually();
      return this.status();
    } catch {
      this.busy = false;
      await this.options.viewer?.stop().catch(() => undefined);
      throw new BrowserSessionError('browser_unavailable', 'No se pudo abrir el navegador de conexión.');
    }
  }

  private async loginManually(): Promise<void> {
    let result: BrowserSessionState = 'expired';
    try {
      const context = await this.launch(false);
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(25_000);
      await page.goto(this.portal, { waitUntil: 'domcontentloaded' });
      const until = Date.now() + (this.dependencies.loginTimeoutMs ?? 300_000);
      let consecutiveMismatches = 0;
      while (!this.cancelled && Date.now() < until && !page.isClosed()) {
        try {
          await verifyIdentity(page, this.portal, this.identity);
          result = 'connected';
          break;
        } catch (error) {
          if (error instanceof BrowserSessionError) { result = 'error'; break; }
          if (error instanceof IdentityMismatch) {
            consecutiveMismatches += 1;
            if (consecutiveMismatches >= 2) { result = 'error'; break; }
          } else {
            consecutiveMismatches = 0;
          }
          // Login redirects and intermediate SSO documents remain under manual control.
        }
        await sleep(this.dependencies.loginPollMs ?? 1000);
      }
    } catch { result = this.cancelled ? 'disconnected' : 'error'; }
    finally {
      const saved = await this.closeContext(result === 'connected' && !this.cancelled);
      await this.options.viewer?.stop().catch(() => undefined);
      if (!saved) result = 'error';
      if (this.cancelled) result = 'disconnected';
      await this.setState(result).catch(() => { this.state = 'error'; });
      this.busy = false;
    }
  }

  async disconnect(): Promise<BrowserSessionStatus> {
    if (this.state === 'connecting' && this.login) {
      this.cancelled = true;
      await this.closeContext();
      await this.login;
    }
    this.ensureReady();
    this.busy = true;
    try {
      if (this.identity) {
        await this.repository.disconnect(this.active);
        await eraseProfile(this.options.profileDir, this.active);
      }
      this.state = 'disconnected';
      await this.options.viewer?.stop();
    } finally { this.busy = false; }
    return this.status();
  }

  private async setState(state: BrowserSessionState) {
    await this.repository.setState(this.active, state);
    this.state = state;
  }

  private async launch(headless: boolean): Promise<BrowserContext> {
    const profile = await protectedProfile(this.options.profileDir, this.active);
    // Every browser-created file is owner-only, including persistent cookies.
    process.umask(0o077);
    const context = this.dependencies.launch
      ? await this.dependencies.launch(profile, headless)
      : await chromium.launchPersistentContext(profile, {
        headless, chromiumSandbox: true, executablePath: this.options.executablePath,
        locale: 'es-PE', timezoneId: 'America/Lima', acceptDownloads: false,
        viewport: headless ? { width: 1280, height: 900 } : { width: 1260, height: 860 },
        args: headless
          ? ['--disable-save-password-bubble']
          : ['--disable-save-password-bubble', '--window-size=1260,860', '--window-position=0,0'],
      });
    this.context = context;
    this.profile = profile;
    await restorePortalCookies(context, profile, this.portal);
    return context;
  }

  private async closeContext(persist = this.state === 'connected' && !this.cancelled): Promise<boolean> {
    const context = this.context;
    this.context = undefined;
    let saved = true;
    try {
      if (context && this.profile && persist) await savePortalCookies(context, this.profile, this.portal);
    } catch { saved = false; this.state = 'error'; }
    finally { await context?.close().catch(() => undefined); }
    return saved;
  }

  private async trackSessionFailure(error: unknown) {
    if (error instanceof SessionExpired) await this.setState('expired');
    if (error instanceof IdentityMismatch) await this.setState('error');
  }

  async fetch(order: { jobId: string; accountId: string }): Promise<CaptureResult> {
    if (!this.ready || this.busy || order.accountId !== this.active) return { kind: 'unavailable' };
    if (this.state !== 'connected') return { kind: 'session_expired' };
    this.busy = true;
    try {
      const context = await this.launch(true);
      await secureContext(context, this.portal, true);
      const page = context.pages()[0] ?? await context.newPage();
      const fetcher = new AulaVirtualFetcher({ accountId: this.active, portalUrl: this.portal, runner: {
        capture: async () => {
          try {
            await page.goto(this.portal, { waitUntil: 'domcontentloaded' });
            await verifyIdentity(page, this.portal, this.identity);
            const assignments = await captureAssignments(page, this.portal);
            await verifyIdentity(page, this.portal, this.identity);
            return { kind: 'success', observedAccountId: this.active, assignments };
          } catch (error) {
            await this.trackSessionFailure(error);
            return { kind: error instanceof SessionExpired ? 'session_expired' : 'failed' };
          }
        },
      } });
      return await fetcher.fetch(order);
    } catch { return { kind: 'failed' }; }
    finally { await this.closeContext(); this.busy = false; }
  }

  async submit(order: DeliveryOrder): Promise<DeliveryResult> { return this.deliver(order, false); }
  async verify(order: DeliveryOrder): Promise<DeliveryResult> { return this.deliver(order, true); }

  private async deliver(order: DeliveryOrder, verification: boolean): Promise<DeliveryResult> {
    const denied: DeliveryResult = { state: verification ? 'needs_verification' : 'failed' };
    if (!this.ready || this.busy || this.state !== 'connected' || order.accountId !== this.active) return denied;
    if (!verification) {
      try { await authorizedPdf({ localFilePath: order.localFilePath, originalName: order.originalName, sha256: order.sha256 }); }
      catch { return denied; }
    }
    this.busy = true;
    const proofStore = this.options.proofStore;
    const writtenProofKeys = new Set<string>();
    let latestProofKey: string | null = null;
    let hasAttached = false;
    let result: DeliveryResult = denied;
    try {
      const context = await this.launch(true);
      await secureContext(context, this.portal, verification);
      const captureProof = proofStore
        ? async (png: Uint8Array, state: DeliveryPageObservation['state']): Promise<string | null> => {
          if (!verification && !hasAttached && state !== 'submitted') return null;
          const key = await proofStore.writePng(png);
          writtenProofKeys.add(key);
          if (latestProofKey && latestProofKey !== key) {
            await proofStore.discard(latestProofKey).catch(() => undefined);
            writtenProofKeys.delete(latestProofKey);
          }
          latestProofKey = key;
          return key;
        }
        : undefined;
      const open = async (target: DeliveryTarget) => {
        const page = context.pages()[0] ?? await context.newPage();
        const editor = new MoodleDeliveryPage(
          page,
          this.portal,
          this.identity,
          target,
          async () => undefined,
          { ...(captureProof ? { captureProof } : {}), alwaysCaptureProof: verification },
        );
        const track = async <T>(run: () => Promise<T>): Promise<T> => {
          try { return await run(); } catch (error) { await this.trackSessionFailure(error); throw error; }
        };
        const guarded: DeliveryPageEditor = {
          inspect: () => track(() => editor.inspect()),
          attachAndSave: (attachment) => track(async () => {
            hasAttached = true;
            await editor.attachAndSave(attachment);
          }),
          submitForGrading: () => track(() => editor.submitForGrading()),
          close: () => editor.close(),
        };
        return { kind: 'opened' as const, page: guarded };
      };
      const browser: AulaVirtualDeliveryBrowser = { openForSubmission: open, openForVerification: open };
      const sender = new AulaVirtualSender({ portalUrl: this.portal, accountId: this.active, browser });
      result = await (verification ? sender.verify(order) : sender.submit(order));
      return result;
    } catch { return denied; }
    finally {
      const retainedProofKey = result.evidence?.proofKey;
      for (const key of writtenProofKeys) {
        if (key !== retainedProofKey) {
          await proofStore?.discard(key).catch(() => undefined);
        }
      }
      await this.closeContext();
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    this.closing = true; this.cancelled = true;
    await this.closeContext();
    await this.login;
    await this.options.viewer?.stop().catch(() => undefined);
    this.ready = false;
    this.lock?.release(true);
    this.lock = undefined;
  }
}
