import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalProofStore } from './files';

const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function createTempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fetcher-proof-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('LocalProofStore writes, reads, and discards valid PNG with strict key format and permissions', async (t) => {
  const dir = await createTempDir(t);
  const storeDir = join(dir, 'proofs');
  const store = new LocalProofStore(storeDir);

  const key = await store.writePng(MINIMAL_PNG);
  assert.match(key, /^[a-f0-9]{32}\.png$/);

  const dirStat = await stat(storeDir);
  assert.equal(dirStat.mode & 0o777, 0o700);

  const fileStat = await stat(join(storeDir, key));
  assert.equal(fileStat.mode & 0o777, 0o600);

  const content = await store.readPng(key);
  assert.ok(content instanceof Uint8Array);
  assert.deepEqual(Buffer.from(content), MINIMAL_PNG);

  await store.discard(key);
  assert.equal(await store.readPng(key), null);

  // Discarding a missing valid key is idempotent
  await store.discard(key);
});

test('LocalProofStore rejects empty and non-PNG payloads', async (t) => {
  const dir = await createTempDir(t);
  const store = new LocalProofStore(dir);

  await assert.rejects(() => store.writePng(new Uint8Array(0)));
  await assert.rejects(() => store.writePng(Buffer.from('%PDF-1.4\nhello\n%%EOF\n')));
  await assert.rejects(() => store.writePng(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  await assert.rejects(() => store.writePng(Buffer.from('not a png image at all')));
});

test('LocalProofStore rejects PNG payloads exceeding 10 MiB', async (t) => {
  const dir = await createTempDir(t);
  const store = new LocalProofStore(dir);

  const maxAllowed = 10 * 1024 * 1024;
  const oversize = Buffer.alloc(maxAllowed + 1);
  MINIMAL_PNG.copy(oversize, 0);

  await assert.rejects(() => store.writePng(oversize));
});

test('LocalProofStore rejects path traversal, invalid keys, and symlinks', async (t) => {
  const dir = await createTempDir(t);
  const storeDir = join(dir, 'proofs');
  const outsideFile = join(dir, 'secret.png');
  await writeFile(outsideFile, MINIMAL_PNG);

  const store = new LocalProofStore(storeDir);
  const invalidKeys = [
    '../secret.png',
    '../../etc/passwd',
    'a'.repeat(32) + '.pdf',
    'A'.repeat(32) + '.png',
    'a'.repeat(31) + '.png',
    'a'.repeat(33) + '.png',
    'subdir/' + 'a'.repeat(32) + '.png',
    'a'.repeat(32) + '.png\0',
    '',
  ];

  for (const key of invalidKeys) {
    assert.equal(await store.readPng(key), null, `readPng should return null for invalid key: ${key}`);
    await assert.rejects(() => store.discard(key), `discard should reject invalid key: ${key}`);
  }

  // Missing valid key returns null
  assert.equal(await store.readPng('b'.repeat(32) + '.png'), null);

  // Outside file must remain untouched
  const outsideStat = await stat(outsideFile);
  assert.equal(outsideStat.size, MINIMAL_PNG.byteLength);

  // Symlink inside proof directory must not be followed by O_NOFOLLOW
  const legitKey = await store.writePng(MINIMAL_PNG);
  await store.discard(legitKey);
  const symlinkKey = 'f'.repeat(32) + '.png';
  await symlink(outsideFile, join(storeDir, symlinkKey));
  await assert.rejects(() => store.readPng(symlinkKey));
});
