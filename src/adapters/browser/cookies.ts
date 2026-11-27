import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Cookie } from 'playwright';

function validCookie(value: unknown, portal: URL): value is Cookie {
  if (!value || typeof value !== 'object') return false;
  const cookie = value as Partial<Cookie>;
  const host = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '') : '';
  return Boolean(host && (portal.hostname === host || portal.hostname.endsWith('.' + host))
    && typeof cookie.name === 'string' && typeof cookie.value === 'string'
    && typeof cookie.path === 'string' && cookie.path.startsWith('/')
    && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires)
    && typeof cookie.httpOnly === 'boolean' && typeof cookie.secure === 'boolean'
    && ['Strict', 'Lax', 'None'].includes(cookie.sameSite ?? ''));
}

export async function savePortalCookies(context: BrowserContext, profile: string, portal: string) {
  const cookies = await context.cookies(portal);
  const path = join(profile, 'portal-session.json');
  const temporary = path + '.tmp';
  const file = await open(temporary, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(cookies)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export async function restorePortalCookies(context: BrowserContext, profile: string, portal: string) {
  const file = await open(join(profile, 'portal-session.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) return;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error('Unsafe session snapshot');
    const cookies: unknown = JSON.parse(await file.readFile('utf8'));
    if (!Array.isArray(cookies) || cookies.length > 500 || !cookies.every((cookie) => validCookie(cookie, new URL(portal)))) throw new Error('Invalid session snapshot');
    await context.addCookies(cookies);
  } finally { await file.close(); }
}
