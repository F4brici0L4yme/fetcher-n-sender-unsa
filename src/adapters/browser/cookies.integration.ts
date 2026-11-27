import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { restorePortalCookies, savePortalCookies } from './cookies';

test('session cookies survive clean browser restart without persisting other origins', async (t) => {
  const profile = await mkdtemp('/tmp/browser-cookie-test-');
  t.diagnostic('Browser scratch for parent cleanup: ' + profile);
  const portal = 'https://aula.example.invalid/2099B/';
  let context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true });
  t.after(() => context.close());
  await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-only', url: portal }, { name: 'OtherSession', value: 'do-not-copy', url: 'https://other.example.invalid/' }]);
  await savePortalCookies(context, profile, portal);
  await context.close();
  context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true });
  await restorePortalCookies(context, profile, portal);
  const cookies = await context.cookies();
  assert.equal(cookies.find((cookie) => cookie.name === 'MoodleSession')?.value, 'synthetic-only');
  assert.equal(cookies.some((cookie) => cookie.name === 'OtherSession'), false);
  assert.equal((await stat(profile + '/portal-session.json')).mode & 0o777, 0o600);
});
