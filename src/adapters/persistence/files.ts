import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PdfStore, ProofStore } from '../../core/application/ports/persistence';

const PROOF_KEY_PATTERN = /^[a-f0-9]{32}\.png$/;
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PROOF_BYTES = 10 * 1024 * 1024;

function isValidPng(content: Uint8Array): boolean {
  if (content.byteLength < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (content[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

export class LocalPdfStore implements PdfStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  path(storageKey: string): string {
    if (!/^[a-f0-9]{32}\.pdf$/.test(storageKey)) throw new Error('Clave de PDF inválida.');
    return resolve(this.directory, storageKey);
  }

  async write(content: Uint8Array) {
    const pdfId = randomUUID();
    const storageKey = pdfId.replaceAll('-', '') + '.pdf';
    const path = this.path(storageKey);
    const temporary = path + '.tmp';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { pdfId, storageKey, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength };
  }

  async discard(storageKey: string): Promise<void> {
    await rm(this.path(storageKey), { force: true });
  }

  async verifiedPath(storageKey: string, sha256: string): Promise<string> {
    const path = this.path(storageKey);
    const hash = createHash('sha256');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error('El PDF autorizado no es un archivo.');
      for await (const chunk of createReadStream(path, { fd: file.fd, autoClose: false })) {
        hash.update(chunk);
      }
    } finally {
      await file.close();
    }
    if (hash.digest('hex') !== sha256) throw new Error('El PDF autorizado cambió.');
    return path;
  }
}

export class LocalProofStore implements ProofStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  path(storageKey: string): string {
    if (!PROOF_KEY_PATTERN.test(storageKey)) throw new Error('Clave de captura inválida.');
    return resolve(this.directory, storageKey);
  }

  async writePng(content: Uint8Array): Promise<string> {
    if (content.byteLength === 0) throw new Error('La captura PNG está vacía.');
    if (content.byteLength > MAX_PROOF_BYTES) {
      throw new Error('La captura PNG supera el tamaño máximo permitido de 10 MiB.');
    }
    if (!isValidPng(content)) throw new Error('El contenido no es una imagen PNG válida.');

    const storageKey = randomUUID().replaceAll('-', '') + '.png';
    const target = this.path(storageKey);
    const temporary = target + '.tmp';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return storageKey;
  }

  async readPng(storageKey: string): Promise<Uint8Array | null> {
    if (!PROOF_KEY_PATTERN.test(storageKey)) return null;
    const target = resolve(this.directory, storageKey);
    let file;
    try {
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > MAX_PROOF_BYTES) {
        return null;
      }
      const data = await file.readFile();
      return isValidPng(data) ? data : null;
    } finally {
      await file.close();
    }
  }

  async discard(storageKey: string): Promise<void> {
    await rm(this.path(storageKey), { force: true });
  }
}
