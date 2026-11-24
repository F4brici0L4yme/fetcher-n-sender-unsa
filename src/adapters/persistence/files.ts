import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PdfStore } from '../../core/application/ports/persistence';

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
