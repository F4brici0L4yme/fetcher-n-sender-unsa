import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoginViewer } from './personal-browser';

export interface LoginViewerAccess {
  url: string;
  password: string;
}

export interface ContainerLoginViewerOptions {
  display: string;
  port: number;
  hostPort: number;
  vncBin?: string;
  proxyBin?: string;
}

function spawnVerified(command: string, args: string[], settleMs = 150): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onEarlyExit);
      if (error) reject(error);
      else resolve(child);
    };
    const onError = (error: Error) => finish(error);
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`${command} exited early (${code ?? signal ?? 'unknown'})`));
    };
    const onSpawn = () => {
      timer = setTimeout(() => finish(), settleMs);
    };
    child.on('error', onError);
    child.once('spawn', onSpawn);
    child.once('exit', onEarlyExit);
  });
}

function stopProcess(proc: ChildProcess, timeoutMs = 2000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    };
    proc.once('exit', finish);
    proc.once('close', finish);
    try { proc.kill('SIGTERM'); } catch { finish(); return; }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish();
    }, timeoutMs);
  });
}

export class ContainerLoginViewer implements LoginViewer {
  private vnc?: ChildProcess;
  private proxy?: ChildProcess;
  private tempDir?: string;
  private currentAccess?: LoginViewerAccess;

  constructor(private readonly options: ContainerLoginViewerOptions) {}

  access(): LoginViewerAccess | null {
    return this.currentAccess ?? null;
  }

  async start(): Promise<void> {
    await this.stop();
    const password = randomBytes(9).toString('base64url').slice(0, 8);
    const dir = await mkdtemp(join(tmpdir(), 'homework-viewer-'));
    this.tempDir = dir;
    try {
      const passwordFile = join(dir, 'vnc.passwd');
      const handle = await open(passwordFile, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(password + '\n', 'utf8');
      } finally {
        await handle.close();
      }

      const vncPort = 5900;
      const vnc = await spawnVerified(this.options.vncBin ?? 'x11vnc', [
        '-display', this.options.display,
        '-localhost',
        '-rfbport', String(vncPort),
        '-passwdfile', passwordFile,
        '-forever',
        '-noshared',
        '-xkb',
        '-repeat',
        '-clear_all',
        '-skip_lockkeys',
      ]);
      this.vnc = vnc;

      const proxy = await spawnVerified(this.options.proxyBin ?? 'websockify', [
        '--web', '/usr/share/novnc',
        `0.0.0.0:${this.options.port}`,
        `127.0.0.1:${vncPort}`,
      ]);
      this.proxy = proxy;

      this.currentAccess = {
        url: `http://127.0.0.1:${this.options.hostPort}/vnc.html?autoconnect=1&resize=scale`,
        password,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.currentAccess = undefined;
    const processes = [this.proxy, this.vnc].filter((proc): proc is ChildProcess => Boolean(proc));
    this.proxy = undefined;
    this.vnc = undefined;
    await Promise.all(processes.map((proc) => stopProcess(proc)));
    if (this.tempDir) {
      const dir = this.tempDir;
      this.tempDir = undefined;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
