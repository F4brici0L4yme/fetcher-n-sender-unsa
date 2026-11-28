import { createHash } from 'node:crypto';
import type { BrowserContext, Locator, Page, Request } from 'playwright';
import { visibleDeadline } from '../../core/domain/deadline';
import type { CapturedAssignment } from '../../core/domain/model';
import type { AuthorizedAttachment, DeliveryPageEditor, DeliveryPageObservation, DeliveryTarget } from '../sender/aula-virtual-delivery-browser';
import { authorizedPdf } from './profiles';
import { normalizeIdentity, parseMoodleDeadline, validatePortalLink } from './security';

export class SessionExpired extends Error {}
export class IdentityMismatch extends Error {}

const EMAIL_PATTERN = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]+/g;

function normalizeObservedEmails(candidates: string[]): string[] {
  const observed = new Set<string>();
  const tryAdd = (raw: string) => {
    const trimmed = raw.trim().replace(/^mailto:/i, '').split('?')[0]?.trim() ?? '';
    if (!trimmed) return;
    try {
      observed.add(normalizeIdentity(trimmed));
      return;
    } catch {
      // Fall through to extract embedded email addresses from descriptive text.
    }
    for (const match of trimmed.matchAll(EMAIL_PATTERN)) {
      const token = match[0].replace(/[.,;:!?)]+$/, '');
      try {
        observed.add(normalizeIdentity(token));
      } catch {
        // Ignore non-email tokens.
      }
    }
  };
  for (const candidate of candidates) {
    tryAdd(candidate);
  }
  return [...observed];
}

export async function requirePortalPage(page: Page, portal: string) {
  if (!validatePortalLink(page.url(), portal, false)) throw new SessionExpired();
  const pathname = new URL(page.url()).pathname;
  if (/\/(?:login|auth\/oauth2)\//.test(pathname)) throw new SessionExpired();
  if (await page.locator('body.notloggedin, form#login, input[name="username"]').count()) throw new SessionExpired();
  const hasLoginPrompt = await page.locator('.logininfo a[href*="/login/"], .usermenu .login a[href*="/login/"]').count();
  if (hasLoginPrompt && !(await page.locator('body.loggedin, .usermenu a[href*="/user/profile.php"]').count())) {
    throw new SessionExpired();
  }
}

async function extractProfileEmailGroups(profile: Page): Promise<{ profileEmails: string[]; regionEmails: string[] }> {
  await profile.locator('.userprofile, #region-main, main, dl dt, a[href^="mailto:" i]')
    .first()
    .waitFor({ state: 'attached', timeout: 4000 })
    .catch(() => undefined);

  const labelCandidates = await profile.locator('.userprofile dl dt, dl dt').evaluateAll((labels) => {
    const found: string[] = [];
    const labelPattern = /^(direcci[oó]n de correo|correo electr[oó]nico|email address|correo)$/i;
    for (const node of labels) {
      if (!labelPattern.test(node.textContent?.trim() ?? '')) continue;
      const dd = node.nextElementSibling;
      if (!dd) continue;
      for (const anchor of dd.querySelectorAll('a[href^="mailto:" i]')) {
        const href = anchor.getAttribute('href')?.trim() ?? '';
        if (/^mailto:/i.test(href)) {
          const raw = href.slice(7).split('?')[0] ?? '';
          if (raw) {
            found.push(raw);
            try { found.push(decodeURIComponent(raw)); } catch { /* ignore malformed URI */ }
          }
        }
        const text = anchor.textContent?.trim() ?? '';
        if (text) found.push(text);
      }
      const ddText = dd.textContent?.trim() ?? '';
      if (ddText) found.push(ddText);
    }
    return found;
  });

  const profileMailtoCandidates = await profile.locator('.userprofile a[href^="mailto:" i]').evaluateAll((anchors) => {
    const found: string[] = [];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href')?.trim() ?? '';
      if (/^mailto:/i.test(href)) {
        const raw = href.slice(7).split('?')[0] ?? '';
        if (raw) {
          found.push(raw);
          try { found.push(decodeURIComponent(raw)); } catch { /* ignore malformed URI */ }
        }
      }
      const text = anchor.textContent?.trim() ?? '';
      if (text) found.push(text);
    }
    return found;
  });

  const profileTextCandidates = await profile.locator('.userprofile').evaluateAll((sections) => {
    const found: string[] = [];
    const regex = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g;
    for (const section of sections) {
      for (const match of (section.textContent ?? '').matchAll(regex)) {
        found.push(match[0]);
      }
    }
    return found;
  });

  const regionMailtoCandidates = await profile.locator('#region-main a[href^="mailto:" i], main a[href^="mailto:" i]').evaluateAll((anchors) => {
    const found: string[] = [];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href')?.trim() ?? '';
      if (/^mailto:/i.test(href)) {
        const raw = href.slice(7).split('?')[0] ?? '';
        if (raw) {
          found.push(raw);
          try { found.push(decodeURIComponent(raw)); } catch { /* ignore malformed URI */ }
        }
      }
      const text = anchor.textContent?.trim() ?? '';
      if (text) found.push(text);
    }
    return found;
  });

  return {
    profileEmails: normalizeObservedEmails([...labelCandidates, ...profileMailtoCandidates, ...profileTextCandidates]),
    regionEmails: normalizeObservedEmails(regionMailtoCandidates),
  };
}

export async function extractObservedEmails(profile: Page): Promise<string[]> {
  const { profileEmails, regionEmails } = await extractProfileEmailGroups(profile);
  return [...new Set([...profileEmails, ...regionEmails])];
}

async function extractEditProfileEmails(profile: Page): Promise<string[]> {
  await profile.locator('input[name="email"], #id_email, #fitem_id_email, #region-main, main, form')
    .first()
    .waitFor({ state: 'attached', timeout: 2500 })
    .catch(() => undefined);

  const inputValues = await profile.locator('input[name="email"], #id_email').evaluateAll((nodes) =>
    nodes.map((node) => ('value' in node && typeof (node as { value?: unknown }).value === 'string'
      ? (node as { value: string }).value
      : node.getAttribute('value') ?? '')));

  const staticFieldValues = await profile.locator('#fitem_id_email .felement, #fitem_id_email').evaluateAll((nodes) => {
    const found: string[] = [];
    for (const node of nodes) {
      for (const anchor of node.querySelectorAll('a[href^="mailto:" i]')) {
        const href = anchor.getAttribute('href')?.trim() ?? '';
        if (/^mailto:/i.test(href)) {
          const raw = href.slice(7).split('?')[0] ?? '';
          if (raw) {
            found.push(raw);
            try { found.push(decodeURIComponent(raw)); } catch { /* ignore malformed URI */ }
          }
        }
        const text = anchor.textContent?.trim() ?? '';
        if (text) found.push(text);
      }
      const text = node.textContent?.trim() ?? '';
      if (text) found.push(text);
    }
    return found;
  });

  return normalizeObservedEmails([...inputValues, ...staticFieldValues]);
}

export async function verifyIdentity(page: Page, portal: string, expected: string): Promise<void> {
  const normalizedExpected = normalizeIdentity(expected);
  await requirePortalPage(page, portal);
  const profile = await page.context().newPage();
  profile.setDefaultTimeout(8000);
  try {
    const profileLink = page.locator('.usermenu a[href*="/user/profile.php"]').first();
    const link = (await profileLink.count()) > 0
      ? await profileLink.getAttribute('href', { timeout: 1000 }).catch(() => null)
      : null;
    const target = validatePortalLink(link ?? new URL('user/profile.php', portal).href, portal, true);
    if (!target) throw new IdentityMismatch();
    await profile.goto(target, { waitUntil: 'domcontentloaded' });
    await requirePortalPage(profile, portal);

    const { profileEmails, regionEmails } = await extractProfileEmailGroups(profile);
    const observed = [...new Set([...profileEmails, ...regionEmails])];
    if (observed.includes(normalizedExpected)) return;
    if (profileEmails.length > 0) throw new IdentityMismatch();

    // When email is hidden on /user/profile.php, fall back to the user's own profile edit page.
    for (const editPath of ['user/edit.php', 'user/editadvanced.php']) {
      const editTarget = validatePortalLink(new URL(editPath, portal).href, portal, true);
      if (!editTarget) continue;
      await profile.goto(editTarget, { waitUntil: 'domcontentloaded' });
      await requirePortalPage(profile, portal);
      const editEmails = await extractEditProfileEmails(profile);
      if (editEmails.includes(normalizedExpected)) return;
      if (editEmails.length > 0) throw new IdentityMismatch();
    }

    if (observed.length > 0) throw new IdentityMismatch();
    throw new SessionExpired();
  } finally {
    await profile.close().catch(() => undefined);
  }
}

async function links(page: Page, selector: string, portal: string): Promise<string[]> {
  const hrefs = await page.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''));
  return [...new Set(hrefs.map((href) => validatePortalLink(href, portal, true)).filter((href): href is string => href !== null))];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMatchKey(value: string): string {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function classifySubmissionStatus(visibleStatus: string): DeliveryPageObservation['state'] {
  const normalized = normalizeMatchKey(visibleStatus);
  if (!normalized) return 'unknown';
  if (/^(?:enviado para calificar|enviado para calificacion|entregado para calificar|entregado para calificacion|submitted for grading)\b/.test(normalized)) {
    return 'submitted';
  }
  if (/^(?:borrador|draft)\b/.test(normalized)) {
    return 'draft';
  }
  if (/^(?:todavia no se han realizado envios?|no se ha enviado nada|no enviado|no entregado|sin intento|sin entregas?|sin envios?|no submissions?|no attempt|nothing has been submitted|not submitted)\b/.test(normalized)) {
    return 'open';
  }
  if (/^(?:cerrad|closed\b|no se aceptan entregas\b|submissions are closed\b)/.test(normalized)) {
    return 'closed';
  }
  return 'unknown';
}

function courseIdKey(urlString: string): string | null {
  try {
    const parsed = new URL(urlString);
    if (!parsed.pathname.endsWith('/course/view.php')) return null;
    const id = parsed.searchParams.get('id')?.trim();
    return id && /^\d+$/.test(id) ? `id:${id}` : null;
  } catch {
    return null;
  }
}

function looksLikeShortname(value: string): boolean {
  const trimmed = normalizeText(value);
  if (!trimmed) return true;
  return !/\s/.test(trimmed) && /[_-]/.test(trimmed) && /\d/.test(trimmed);
}

async function extractCourseHeading(page: Page): Promise<string> {
  const candidates = [
    page.locator('.page-header-headings h1').first(),
    page.locator('#page-header h1').first(),
    page.locator('h1').last(),
  ];
  for (const locator of candidates) {
    if ((await locator.count()) > 0) {
      const text = normalizeText(await locator.innerText().catch(() => ''));
      if (text) return text;
    }
  }
  return '';
}

function recordCourseName(courseNames: Map<string, string>, keys: Array<string | null>, name: string): void {
  const cleaned = normalizeText(name);
  if (!cleaned) return;
  const cleanedIsShort = looksLikeShortname(cleaned);
  for (const key of keys) {
    if (!key) continue;
    const current = courseNames.get(key);
    if (!current) {
      courseNames.set(key, cleaned);
      continue;
    }
    const currentIsShort = looksLikeShortname(current);
    if (
      (currentIsShort && !cleanedIsShort)
      || (currentIsShort === cleanedIsShort && cleaned.length > current.length)
    ) {
      courseNames.set(key, cleaned);
    }
  }
}

async function resolveCourseName(
  page: Page,
  portal: string,
  courseNames: ReadonlyMap<string, string>,
  assignmentTitle: string,
): Promise<string> {
  const breadcrumbLinks = await page
    .locator('.breadcrumb a[href*="/course/view.php"], nav[aria-label] a[href*="/course/view.php"]')
    .evaluateAll((nodes) => nodes.map((node) => ({
      href: node.getAttribute('href') ?? '',
      title: node.getAttribute('title') ?? '',
      text: node.textContent ?? '',
    })));

  let linkHref: string | null = null;
  let linkTitle = '';
  let linkText = '';
  for (const candidate of breadcrumbLinks) {
    const validated = validatePortalLink(candidate.href, portal, true);
    if (!validated) continue;
    linkHref = validated;
    linkTitle = normalizeText(candidate.title);
    linkText = normalizeText(candidate.text);
    break;
  }

  const idKey = linkHref ? courseIdKey(linkHref) : null;
  const mapped = normalizeText((linkHref ? courseNames.get(linkHref) : undefined) ?? (idKey ? courseNames.get(idKey) : undefined) ?? '');
  const isMappedBetter = Boolean(mapped) && (
    !linkText
    || (!looksLikeShortname(mapped) && (looksLikeShortname(linkText) || mapped.length >= linkText.length))
    || (looksLikeShortname(mapped) === looksLikeShortname(linkText) && mapped.length > linkText.length)
  );
  if (isMappedBetter && (!linkTitle || !looksLikeShortname(mapped) || linkTitle.length <= mapped.length)) {
    return mapped;
  }

  if (
    linkTitle
    && (!linkText
      || (looksLikeShortname(linkText) && !looksLikeShortname(linkTitle))
      || (looksLikeShortname(linkText) === looksLikeShortname(linkTitle) && linkTitle.length > linkText.length))
  ) {
    return linkTitle;
  }

  const headerText = normalizeText(
    await page.locator('.page-header-headings').first().innerText().catch(() => ''),
  );
  const normalizedAssignmentTitle = normalizeMatchKey(assignmentTitle);
  const usableHeader = headerText && normalizeMatchKey(headerText) !== normalizedAssignmentTitle ? headerText : '';
  if (usableHeader && (!linkText || looksLikeShortname(linkText))) {
    return usableHeader;
  }

  return linkText || mapped || linkTitle || usableHeader;
}

async function hasOpenSubmissionAction(page: Page): Promise<boolean> {
  return page
    .locator('button, input[type="submit"], a.btn, a[href*="action=editsubmission"]')
    .evaluateAll((nodes) =>
      nodes.some((node) => {
        const href = node.getAttribute('href') ?? '';
        if (href.includes('action=editsubmission')) return true;
        const label = (
          node.textContent
          || (node as HTMLInputElement).value
          || ''
        ).replace(/\s+/g, ' ').trim();
        return /^(?:agregar entrega|a[ñn]adir env[ií]o|editar entrega|add submission|edit submission)$/i.test(label);
      }),
    );
}

async function extractDeadline(page: Page): Promise<string | null> {
  const tableCandidates = await page.locator('.submissionstatustable tr').evaluateAll((rows) => {
    const labelPattern = /^(?:fecha de entrega|fecha l[ií]mite|vencimiento|cierre|due(?:\s+date)?)$/i;
    const found: string[] = [];
    for (const row of rows) {
      const firstCell = row.querySelector('th, td');
      const label = (firstCell?.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/:$/, '');
      if (!labelPattern.test(label)) continue;
      const value = (row.querySelector('td:last-child')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (value) found.push(value);
    }
    return found;
  });

  const activityDateCandidates = await page.locator('.activity-dates, [data-region="activity-dates"]').evaluateAll((containers) => {
    const labelPattern = /^(?:cierre|vencimiento|fecha de entrega|fecha l[ií]mite|due(?:\s+date)?)\s*:\s*(.+)$/i;
    const found: string[] = [];
    const seen = new Set<string>();
    const pushIfMatch = (raw: string) => {
      const collapsed = raw.replace(/\s+/g, ' ').trim();
      const match = collapsed.match(labelPattern);
      if (!match?.[1]) return;
      const value = match[1].trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        found.push(value);
      }
    };
    for (const container of containers) {
      const rows = Array.from(container.querySelectorAll('div, p, li, tr')).filter(
        (el) => !el.querySelector('div, p, li, tr'),
      );
      if (rows.length > 0) {
        for (const row of rows) pushIfMatch(row.textContent ?? '');
      } else {
        for (const line of (container.textContent ?? '').split(/\r?\n/)) pushIfMatch(line);
      }
    }
    return found;
  });

  for (const candidate of [...tableCandidates, ...activityDateCandidates]) {
    const parsed = parseMoodleDeadline(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function canonicalizeAssignmentUrl(rawUrl: string, portal: string): string | null {
  const validated = validatePortalLink(rawUrl, portal, true);
  if (!validated) return null;
  try {
    const parsed = new URL(validated);
    if (!parsed.pathname.endsWith('/mod/assign/view.php')) return null;
    const id = parsed.searchParams.get('id')?.trim();
    if (!id || !/^\d+$/.test(id)) return null;
    const canonical = new URL(parsed.pathname, parsed.origin);
    canonical.searchParams.set('id', id);
    return validatePortalLink(canonical.href, portal, true);
  } catch {
    return null;
  }
}

async function extractAssignmentTitle(page: Page): Promise<string> {
  const candidates = [
    page.locator('.page-header-headings h1').first(),
    page.locator('[role="main"] h1').first(),
    page.locator('h1').last(),
  ];
  for (const locator of candidates) {
    if ((await locator.count()) > 0) {
      const text = normalizeText(await locator.innerText().catch(() => ''));
      if (text) return text;
    }
  }
  return '';
}

async function isRestrictedActivity(page: Page): Promise<boolean> {
  if ((await page.locator('.submissionstatustable').count()) > 0) return false;
  return (await page.locator('.errorbox, .errormessage, [data-rel="fatalerror"], .availabilityinfo').count()) > 0;
}

export async function captureAssignments(page: Page, portal: string): Promise<CapturedAssignment[]> {
  const courses = new Set<string>();
  const courseNames = new Map<string, string>();
  const activities = new Set<string>();
  const visited = new Set<string>();
  const myUrl = new URL('my/', portal).href;
  const myCoursesUrl = new URL('my/courses.php', portal).href;
  const queue = [myUrl, myCoursesUrl];
  let seededProfileFallback = false;
  // Bounded traversal only follows course, assignment and pagination links, never arbitrary portal links.
  while (queue.length) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    if (visited.size >= 150) throw new Error('Capture pagination limit exceeded');
    visited.add(url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await requirePortalPage(page, portal);
    const targetPathname = new URL(url).pathname;
    const currentPathname = new URL(page.url()).pathname;
    const isDashboardPage = /\/my\/(?:index\.php|courses\.php)?$/.test(targetPathname)
      || /\/my\/(?:index\.php|courses\.php)?$/.test(currentPathname);
    if (isDashboardPage) {
      await page.locator('a[href*="/course/view.php"]').first().waitFor({ state: 'attached', timeout: 2500 }).catch(() => undefined);
    }
    const idKey = courseIdKey(url) ?? courseIdKey(page.url());
    if (idKey) {
      const heading = await extractCourseHeading(page);
      const finalUrl = validatePortalLink(page.url(), portal, true);
      recordCourseName(courseNames, [url, finalUrl, idKey], heading);
    }
    for (const activity of await links(page, 'a[href*="/mod/assign/view.php"]', portal)) {
      const canonical = canonicalizeAssignmentUrl(activity, portal);
      if (canonical) activities.add(canonical);
    }
    for (const course of await links(page, 'a[href*="/course/view.php"]', portal)) {
      if (!courses.has(course)) { courses.add(course); queue.push(course); }
    }
    if (targetPathname.endsWith('/user/profile.php') || currentPathname.endsWith('/user/profile.php')) {
      for (const userLink of await links(page, 'a[href*="/user/view.php"]', portal)) {
        const courseId = new URL(userLink).searchParams.get('course')?.trim();
        if (!courseId || !/^\d+$/.test(courseId)) continue;
        const canonicalCourse = validatePortalLink(new URL(`course/view.php?id=${courseId}`, portal).href, portal, true);
        if (canonicalCourse && !courses.has(canonicalCourse)) {
          courses.add(canonicalCourse);
          queue.push(canonicalCourse);
        }
      }
    }
    for (const next of await links(page, '.pagination a[href], .paging a[href], a[rel="next"]', portal)) {
      if (!visited.has(next)) queue.push(next);
    }
    if (!seededProfileFallback && visited.has(myUrl) && visited.has(myCoursesUrl) && courses.size === 0) {
      seededProfileFallback = true;
      const profileUrl = validatePortalLink(new URL('user/profile.php', portal).href, portal, true);
      if (profileUrl && !visited.has(profileUrl)) queue.push(profileUrl);
    }
    if (courses.size > 50 || activities.size > 500) throw new Error('Capture activity limit exceeded');
  }
  const assignments: CapturedAssignment[] = [];
  for (const activityUrl of activities) {
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded' });
    await requirePortalPage(page, portal);
    if (await isRestrictedActivity(page)) continue;
    const observation = await assignmentObservation(page);
    if (observation.state === 'submitted' || observation.state === 'closed') continue;
    const externalId = new URL(activityUrl).searchParams.get('id');
    const title = await extractAssignmentTitle(page);
    const course = await resolveCourseName(page, portal, courseNames, title);
    if (!externalId || !/^\d+$/.test(externalId) || !title || !course) throw new Error('Missing assignment identity');
    const parsedDeadline = await extractDeadline(page);
    const deadline = parsedDeadline
      && !visibleDeadline(parsedDeadline, new Date())
      && await hasOpenSubmissionAction(page)
      ? null
      : parsedDeadline;
    assignments.push({ externalId, title, course, activityUrl, deadline, destination: 'aula_virtual' });
  }
  return assignments;
}

async function assignmentObservation(page: Page) {
  const rawStatus = await page.locator('.submissionstatustable tr').evaluateAll((rows) => {
    const row = rows.find((node) => {
      const label = (node.querySelector('th,td')?.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/:$/, '');
      return /^(estado de la entrega|estado de entrega|submission status)$/i.test(label);
    });
    return (row?.querySelector('td:last-child')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
  const visibleStatus = normalizeText(rawStatus);
  const state = classifySubmissionStatus(visibleStatus);
  const attachments = await page.locator('.submissionstatustable').evaluateAll((tables) => {
    const headerPattern = /^(archivos enviados|env[ií]os de archivo|file submissions|archivos de entrega)/i;
    const collect = (anchors: Iterable<Element>) => {
      const seen = new Set<string>();
      const items: Array<{ name: string; href: string }> = [];
      for (const node of anchors) {
        const href = node.getAttribute('href')?.trim() ?? '';
        if (!href || !href.includes('pluginfile.php')) continue;
        if (/\/mod_assign\/intro(?:attachment)?\//i.test(href)) continue;
        const name = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        const key = `${name}\0${href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ name, href });
      }
      return items;
    };

    const rowAnchors: Element[] = [];
    let matchedRowCount = 0;
    for (const table of tables) {
      for (const row of table.querySelectorAll('tr')) {
        const header = (row.querySelector('th, td')?.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/:$/, '');
        if (!headerPattern.test(header)) continue;
        matchedRowCount += 1;
        rowAnchors.push(...row.querySelectorAll('a[href*="pluginfile.php"]'));
      }
    }
    if (matchedRowCount > 0) return collect(rowAnchors);

    const fallbackAnchors: Element[] = [];
    for (const table of tables) {
      fallbackAnchors.push(...table.querySelectorAll('.fileuploadsubmission a[href*="pluginfile.php"], .file a[href*="pluginfile.php"]'));
    }
    return collect(fallbackAnchors);
  });
  return { visibleStatus, state, attachments };
}

const SUBMIT_CONTROL_PATTERN = /^(enviar tarea|enviar env[ií]o|enviar trabajo|entregar tarea|submit assignment)$/i;
const CONFIRM_CONTROL_PATTERN = /^(continuar|continue|confirmar|confirm)$/i;

function actionControl(page: Page, pattern: RegExp): Locator {
  const buttonsAndLinks = page.locator('button:visible, a.btn:visible').filter({ hasText: pattern });
  const submitInputs = page.locator('input[type="submit"]').and(page.getByRole('button', { name: pattern }));
  return buttonsAndLinks.or(submitInputs);
}

async function clickSingle(locator: Locator) {
  if (await locator.count() !== 1) throw new Error('Expected one Moodle control');
  await locator.click();
}

export type ProofCaptureCallback = (png: Uint8Array, state: DeliveryPageObservation['state']) => Promise<string | null>;

export interface MoodleDeliveryPageOptions {
  captureProof?: ProofCaptureCallback;
  alwaysCaptureProof?: boolean;
}

const HEADLESS_DELIVERY_VIEWPORT = { width: 1280, height: 900 };
const MAX_VERIFICATION_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function isSafeVerificationUrl(rawUrl: string, portal: string): boolean {
  const validated = validatePortalLink(rawUrl, portal, true);
  if (!validated) return false;
  return !/\/(?:login|auth\/oauth2)\//.test(new URL(validated).pathname);
}

async function fetchAttachmentSha256(page: Page, portal: string, href: string): Promise<string | undefined> {
  const validatedHref = validatePortalLink(href, portal, true);
  if (!validatedHref || !isSafeVerificationUrl(validatedHref, portal)) return undefined;

  try {
    const browserFetch = await page.evaluate(
      async ({ url, maxBytes, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            mode: 'same-origin',
            redirect: 'manual',
            signal: controller.signal,
          });
          if (response.type === 'opaqueredirect' || !response.ok) return { kind: 'rejected' as const };
          const declaredLength = Number(response.headers.get('content-length') ?? '');
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            return { kind: 'rejected' as const };
          }
          let bytes: Uint8Array<ArrayBuffer>;
          if (response.body) {
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              total += value.byteLength;
              if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return { kind: 'rejected' as const };
              }
              chunks.push(value);
            }
            bytes = new Uint8Array(new ArrayBuffer(total));
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
          } else {
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > maxBytes) return { kind: 'rejected' as const };
            bytes = new Uint8Array(buffer);
          }
          if (bytes.byteLength === 0 || !crypto?.subtle) return { kind: 'rejected' as const };
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
          return { kind: 'ok' as const, finalUrl: response.url || url, sha256 };
        } catch {
          return { kind: 'error' as const };
        } finally {
          clearTimeout(timer);
        }
      },
      { url: validatedHref, maxBytes: MAX_VERIFICATION_ATTACHMENT_BYTES, timeoutMs: 10_000 },
    );

    if (browserFetch.kind === 'ok') {
      if (!isSafeVerificationUrl(browserFetch.finalUrl, portal)) return undefined;
      return /^[a-f0-9]{64}$/.test(browserFetch.sha256) ? browserFetch.sha256 : undefined;
    }
    if (browserFetch.kind === 'rejected') return undefined;
  } catch {
    // Fall through to Playwright APIRequestContext read-only GET when page evaluation is unavailable.
  }

  try {
    const response = await page.request.get(validatedHref, { timeout: 10_000, maxRedirects: 0 });
    if (!response.ok() || !isSafeVerificationUrl(response.url(), portal)) return undefined;
    const declaredLength = Number(response.headers()['content-length'] ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_VERIFICATION_ATTACHMENT_BYTES) return undefined;
    const body = await response.body();
    if (body.byteLength === 0 || body.byteLength > MAX_VERIFICATION_ATTACHMENT_BYTES) return undefined;
    return createHash('sha256').update(body).digest('hex');
  } catch {
    return undefined;
  }
}

export class MoodleDeliveryPage implements DeliveryPageEditor {
  private mutated = false;

  constructor(
    private readonly page: Page,
    private readonly portal: string,
    private readonly expectedIdentity: string,
    private readonly target: DeliveryTarget,
    private readonly closeContext: () => Promise<void>,
    private readonly options: MoodleDeliveryPageOptions = {},
  ) {}

  async inspect(): Promise<DeliveryPageObservation> {
    const viewport = this.page.viewportSize();
    if (!viewport || viewport.width < HEADLESS_DELIVERY_VIEWPORT.width || viewport.height < HEADLESS_DELIVERY_VIEWPORT.height) {
      await this.page.setViewportSize(HEADLESS_DELIVERY_VIEWPORT).catch(() => undefined);
    }
    await this.page.goto(this.target.activityUrl, { waitUntil: 'domcontentloaded' });
    await verifyIdentity(this.page, this.portal, this.expectedIdentity);
    const url = new URL(this.page.url());
    const observed = await assignmentObservation(this.page);
    let attachments: Array<{ name: string; sha256?: string }> = observed.attachments.map(({ name }) => ({ name }));
    if (this.options.alwaysCaptureProof && observed.state === 'submitted' && observed.attachments.length === 1) {
      const only = observed.attachments[0]!;
      const sha256 = await fetchAttachmentSha256(this.page, this.portal, only.href);
      attachments = [sha256 ? { name: only.name, sha256 } : { name: only.name }];
    }
    const shouldCapture = Boolean(this.options.captureProof) && (
      this.options.alwaysCaptureProof
      || this.mutated
      || observed.state === 'submitted'
      || (observed.state === 'draft' && observed.attachments.length > 0)
      || observed.state === 'closed'
    );
    const proof = shouldCapture ? await this.captureVisualProof(observed.state) : null;
    return {
      visibleStatus: observed.visibleStatus,
      state: observed.state,
      attachments,
      accountId: this.target.accountId,
      externalId: url.searchParams.get('id') ?? '',
      activityUrl: url.href,
      ...(proof ?? {}),
    };
  }

  private async captureVisualProof(state: DeliveryPageObservation['state']): Promise<{ proofKey: string; capturedAt: string } | null> {
    if (!this.options.captureProof) return null;
    try {
      const png = await this.takeProofScreenshot();
      if (!png || png.byteLength === 0) return null;
      const proofKey = await this.options.captureProof(png, state);
      if (!proofKey) return null;
      return { proofKey, capturedAt: new Date().toISOString() };
    } catch {
      // Visual proof capture must never fail or alter a Moodle delivery verdict.
      return null;
    }
  }

  private async takeProofScreenshot(): Promise<Uint8Array> {
    for (const selector of ['.submissionstatustable', '#region-main']) {
      const target = this.page.locator(selector).first();
      try {
        if ((await target.count()) > 0 && await target.isVisible()) {
          const box = await target.boundingBox();
          if (box && box.width > 0 && box.height > 0 && box.height <= 2400) {
            return await target.screenshot({ type: 'png', animations: 'disabled', timeout: 5_000 });
          }
        }
      } catch {
        // Fall through to the next selector or full viewport capture.
      }
    }
    return this.page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 5_000 });
  }

  async attachAndSave(attachment: AuthorizedAttachment): Promise<void> {
    // Read/hash once and upload those bytes under the authorized original name.
    const payload = await authorizedPdf(attachment);
    await verifyIdentity(this.page, this.portal, this.expectedIdentity);
    const edit = new URL(this.target.activityUrl);
    edit.searchParams.set('action', 'editsubmission');
    await this.page.goto(edit.href, { waitUntil: 'domcontentloaded' });
    await requirePortalPage(this.page, this.portal);
    const onRequest = (req: Request) => {
      if (!['GET', 'HEAD'].includes(req.method())) this.mutated = true;
    };
    this.page.on('request', onRequest);
    try {
      const fileManager = this.page.locator('.filemanager:not(.fp-select)');
      const hasFileManager = (await fileManager.count()) > 0;
      if (hasFileManager) {
        await this.page.locator('.filemanager:not(.fp-select):not(.fm-loading)').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
      }
      const existing = fileManager.locator('.fp-file:not(.fp-folder)');
      if (await existing.count() > 0) throw new Error('Existing draft must not be replaced');

      const focusedUploadInput = this.page.locator('.moodle-dialogue-focused .fp-upload-form input[type="file"]:visible');
      const visibleUploadInput = this.page.locator('.fp-upload-form input[type="file"]:visible');

      if (hasFileManager && (await focusedUploadInput.count()) === 0 && (await visibleUploadInput.count()) === 0) {
        const visibleAddButton = fileManager.locator('.fp-btn-add a:visible, .fp-btn-add button:visible');
        const addButton = (await visibleAddButton.count()) > 0
          ? visibleAddButton
          : fileManager.locator('.fp-btn-add a, .fp-btn-add button');
        if ((await addButton.count()) > 0) {
          await clickSingle(addButton);
          const repoArea = this.page.locator('.moodle-dialogue-focused .fp-repo-area:visible, .fp-repo-area:visible');
          await repoArea.or(focusedUploadInput).or(visibleUploadInput).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
          if ((await focusedUploadInput.count()) === 0 && (await visibleUploadInput.count()) === 0) {
            const focusedRepo = this.page.locator('.moodle-dialogue-focused .fp-repo-area .fp-repo:visible').filter({ hasText: /subir un archivo|upload a file/i });
            const visibleRepo = this.page.locator('.fp-repo-area .fp-repo:visible').filter({ hasText: /subir un archivo|upload a file/i });
            const fallbackRepo = this.page.locator('.fp-repo-area .fp-repo').filter({ hasText: /subir un archivo|upload a file/i });
            const repo = (await focusedRepo.count()) > 0 ? focusedRepo : (await visibleRepo.count()) > 0 ? visibleRepo : fallbackRepo;
            await clickSingle(repo);
            await focusedUploadInput.or(visibleUploadInput).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
          }
        }
      }

      const inputCandidates: Locator[] = [
        focusedUploadInput,
        visibleUploadInput,
        this.page.locator('.moodle-dialogue-focused .fp-upload-form input[type="file"]'),
        this.page.locator('.fp-upload-form input[type="file"]'),
        this.page.locator('input[type="file"]:visible'),
        this.page.locator('input[type="file"]'),
      ];
      let input: Locator | null = null;
      for (const candidate of inputCandidates) {
        const count = await candidate.count();
        if (count === 1) {
          input = candidate;
          break;
        }
        if (count > 1 && (candidate === focusedUploadInput || candidate === visibleUploadInput)) {
          throw new Error('Ambiguous Moodle file upload');
        }
      }
      if (!input) throw new Error('Ambiguous Moodle file upload');
      await input.setInputFiles(payload);

      const focusedUploadBtn = this.page.locator('.moodle-dialogue-focused .fp-upload-btn:visible');
      const visibleUploadBtn = this.page.locator('.fp-upload-btn:visible');
      const pickerUpload = (await focusedUploadBtn.count()) > 0
        ? focusedUploadBtn
        : (await visibleUploadBtn.count()) > 0
          ? visibleUploadBtn
          : hasFileManager
            ? this.page.locator('.fp-upload-btn')
            : null;
      if (pickerUpload && (await pickerUpload.count()) > 0) {
        const focusedSaveAs = this.page.locator('.moodle-dialogue-focused .fp-upload-form input[name="title"]:visible');
        const visibleSaveAs = this.page.locator('.fp-upload-form input[name="title"]:visible');
        const saveAs = (await focusedSaveAs.count()) === 1
          ? focusedSaveAs
          : (await visibleSaveAs.count()) === 1
            ? visibleSaveAs
            : this.page.locator('.fp-upload-form input[name="title"]');
        if ((await saveAs.count()) === 1) await saveAs.fill(attachment.originalName);
        if (await pickerUpload.count() !== 1) throw new Error('Expected one Moodle control');
        this.mutated = true;
        await pickerUpload.click();
        await fileManager.locator('.fp-file:not(.fp-folder)').first().waitFor({ state: 'visible', timeout: 12_000 });
        await this.page.locator('.moodle-dialogue-focused').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
      }
      this.mutated = true;
      await Promise.all([
        this.page.waitForURL((url) => url.href !== edit.href, { waitUntil: 'domcontentloaded' }).catch(() => this.page.waitForLoadState('domcontentloaded')),
        clickSingle(this.page.getByRole('button', { name: /^(guardar cambios|save changes)$/i })),
      ]);
      await requirePortalPage(this.page, this.portal);
    } finally {
      this.page.off('request', onRequest);
    }
  }

  hasMutated(): boolean { return this.mutated; }

  async submitForGrading(): Promise<void> {
    await verifyIdentity(this.page, this.portal, this.expectedIdentity);
    const onRequest = (req: Request) => {
      if (!['GET', 'HEAD'].includes(req.method())) this.mutated = true;
    };
    this.page.on('request', onRequest);
    try {
      const submitControl = actionControl(this.page, SUBMIT_CONTROL_PATTERN);
      if (await submitControl.count() !== 1) throw new Error('Expected one Moodle control');
      const currentUrl = this.page.url();
      this.mutated = true;
      await Promise.all([
        this.page.waitForURL((url) => url.href !== currentUrl, { waitUntil: 'domcontentloaded' }).catch(() => this.page.waitForLoadState('domcontentloaded')),
        submitControl.click(),
      ]);
      if (this.page.url() === currentUrl) await this.page.waitForLoadState('domcontentloaded');
      await requirePortalPage(this.page, this.portal);
      // Do not attest to an authorship declaration on the student's behalf.
      if (await this.page.locator('input[name="submissionstatement"], #id_submissionstatement').count()) throw new Error('Student declaration requires manual verification');
      const confirm = actionControl(this.page, CONFIRM_CONTROL_PATTERN);
      if (await confirm.count() === 1) {
        const confirmUrl = this.page.url();
        await Promise.all([
          this.page.waitForURL((url) => url.href !== confirmUrl, { waitUntil: 'domcontentloaded' }).catch(() => this.page.waitForLoadState('domcontentloaded')),
          confirm.click(),
        ]);
        await requirePortalPage(this.page, this.portal);
      }
    } finally {
      this.page.off('request', onRequest);
    }
  }

  close() { return this.closeContext(); }
}

const READONLY_MOODLE_AJAX_METHODS = new Set<string>([
  'core_course_get_enrolled_courses_by_timeline_classification',
  'core_course_get_recent_courses',
]);

function isAllowedReadOnlyMoodleAjax(request: Request, portal: string): boolean {
  if (request.isNavigationRequest() || request.method() !== 'POST') return false;
  try {
    const normalizedRoot = new URL(portal);
    if (!normalizedRoot.pathname.endsWith('/')) normalizedRoot.pathname += '/';
    const expectedPathname = new URL('lib/ajax/service.php', normalizedRoot).pathname;
    const url = new URL(request.url());
    if (
      url.protocol !== 'https:'
      || url.origin !== normalizedRoot.origin
      || url.username
      || url.password
      || url.pathname !== expectedPathname
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const raw = request.postData();
  if (!raw || raw.length > 32_768) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 5) return false;
    return parsed.every((entry) => (
      typeof entry === 'object'
      && entry !== null
      && !Array.isArray(entry)
      && Object.hasOwn(entry, 'methodname')
      && typeof (entry as { methodname?: unknown }).methodname === 'string'
      && READONLY_MOODLE_AJAX_METHODS.has((entry as { methodname: string }).methodname)
    ));
  } catch {
    return false;
  }
}

export async function secureContext(context: BrowserContext, portal: string, readOnly: boolean) {
  context.setDefaultTimeout(12_000);
  context.setDefaultNavigationTimeout(25_000);
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && !validatePortalLink(request.url(), portal, readOnly)) return route.abort();
    if (readOnly && !['GET', 'HEAD'].includes(request.method()) && !isAllowedReadOnlyMoodleAjax(request, portal)) {
      return route.abort();
    }
    await route.fallback();
  });
}
