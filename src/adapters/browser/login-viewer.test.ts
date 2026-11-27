import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContainerLoginViewer } from './login-viewer';

test('ContainerLoginViewer rejects cleanly on spawn error without crashing the process and leaves no active access', async () => {
  const viewer = new ContainerLoginViewer({
    display: ':99',
    port: 6080,
    hostPort: 6081,
    vncBin: '/nonexistent-x11vnc-binary',
  });
  await assert.rejects(() => viewer.start());
  assert.equal(viewer.access(), null);
});

test('ContainerLoginViewer rejects when a child exits immediately after spawn', async () => {
  const viewer = new ContainerLoginViewer({
    display: ':99',
    port: 6080,
    hostPort: 6081,
    vncBin: process.execPath,
    proxyBin: process.execPath,
  });
  await assert.rejects(() => viewer.start(), /exited early/);
  assert.equal(viewer.access(), null);
});

test('ContainerLoginViewer exposes hostPort URL and stops spawned processes cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'viewer-stub-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = join(dir, 'stub.sh');
  await writeFile(stub, '#!/bin/sh\ntrap "exit 0" TERM INT\nsleep 30\n');
  await chmod(stub, 0o700);
  const viewer = new ContainerLoginViewer({
    display: ':99',
    port: 6080,
    hostPort: 6081,
    vncBin: stub,
    proxyBin: stub,
  });
  await viewer.start();
  const access = viewer.access();
  assert.ok(access);
  assert.equal(access.url, 'http://127.0.0.1:6081/vnc.html?autoconnect=1&resize=scale');
  assert.equal(access.password.length, 8);
  await viewer.stop();
  assert.equal(viewer.access(), null);
  assert.ok((await stat(dir)).isDirectory());
});

test('ContainerLoginViewer spawns x11vnc with keyboard translation and hardened flags', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'viewer-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const argsFile = join(dir, 'vnc-args.txt');
  const vncStub = join(dir, 'vnc-stub.sh');
  const proxyStub = join(dir, 'proxy-stub.sh');
  await writeFile(vncStub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ntrap "exit 0" TERM INT\nsleep 30\n`);
  await writeFile(proxyStub, '#!/bin/sh\ntrap "exit 0" TERM INT\nsleep 30\n');
  await chmod(vncStub, 0o700);
  await chmod(proxyStub, 0o700);
  const viewer = new ContainerLoginViewer({
    display: ':99',
    port: 6080,
    hostPort: 6081,
    vncBin: vncStub,
    proxyBin: proxyStub,
  });
  t.after(() => viewer.stop());
  await viewer.start();
  const access = viewer.access();
  assert.ok(access);
  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  for (const requiredFlag of ['-xkb', '-repeat', '-clear_all', '-skip_lockkeys', '-forever', '-noshared', '-localhost', '-passwdfile', '-display', '-rfbport']) {
    assert.ok(args.includes(requiredFlag), `Expected x11vnc args to include ${requiredFlag}`);
  }
  assert.ok(!args.includes('-norepeat'), 'x11vnc must enable key auto-repeat via -repeat instead of -norepeat');
  assert.ok(!args.includes('-capslock'), 'x11vnc must not pass -capslock to avoid stuck CapsLock state');
  assert.ok(!args.includes('-clear_mods'), 'x11vnc must use -clear_all instead of -clear_mods so lock states are cleared');
  assert.ok(!args.includes(access.password), 'x11vnc password must not be passed as a CLI argument');
  await viewer.stop();
});
