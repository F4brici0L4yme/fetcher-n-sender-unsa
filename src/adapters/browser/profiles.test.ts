import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizedPdf, protectedProfile } from './profiles';

test('profile isolation rejects traversal and symlinks, and uploads exact authorized bytes under original name', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-protection-'));
  t.diagnostic('Browser scratch for parent cleanup: ' + root);
  const id = 'aula-' + 'a'.repeat(64);
  const profile = await protectedProfile(join(root, 'profiles'), id);
  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  await assert.rejects(protectedProfile(join(root, 'profiles'), '../escape'));
  await symlink(join(root, 'profiles'), join(root, 'link'));
  await assert.rejects(protectedProfile(join(root, 'link'), id));
  const path = join(root, 'storage.pdf');
  const buffer = Buffer.from('%PDF-1.4 authorized');
  await writeFile(path, buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const attachment = { localFilePath: path, originalName: 'authorized-name.pdf', sha256 };
  assert.deepEqual(await authorizedPdf(attachment), { name: 'authorized-name.pdf', mimeType: 'application/pdf', buffer });
  await assert.rejects(authorizedPdf({ ...attachment, sha256: '0'.repeat(64) }));
  await symlink(path, join(root, 'linked.pdf'));
  await assert.rejects(authorizedPdf({ ...attachment, localFilePath: join(root, 'linked.pdf') }));
});
