import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { AuthorizedAttachment } from '../sender/aula-virtual-delivery-browser';

export async function protectedProfile(root: string, account: string): Promise<string> {
  if (!isAbsolute(root) || !/^aula-[a-f0-9]{64}$/.test(account)) throw new Error('Invalid browser profile location');
  const resolved = resolve(root);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  if ((await lstat(resolved)).isSymbolicLink() || await realpath(resolved) !== resolved) throw new Error('Profile root must not be a symlink');
  await chmod(resolved, 0o700);
  const directory = join(resolved, account);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid profile directory');
  await chmod(directory, 0o700);
  return directory;
}

export async function eraseProfile(root: string, account: string): Promise<void> {
  const path = await protectedProfile(root, account);
  await rm(path, { recursive: true, force: true });
}

export async function authorizedPdf(attachment: AuthorizedAttachment): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  if (!isAbsolute(attachment.localFilePath) || !attachment.originalName.trim() || /[\\/\x00-\x1f]/.test(attachment.originalName)) throw new Error('Invalid authorized attachment');
  const file = await open(attachment.localFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024) throw new Error('Invalid PDF size');
    const buffer = await file.readFile();
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-')) || createHash('sha256').update(buffer).digest('hex') !== attachment.sha256) throw new Error('Authorized PDF changed');
    return { name: attachment.originalName, mimeType: 'application/pdf', buffer };
  } finally { await file.close(); }
}
