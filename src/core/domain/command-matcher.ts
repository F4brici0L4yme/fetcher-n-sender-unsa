import { TaskView } from './model';

const STOP_WORDS = new Set([
  'a', 'al', 'archivo', 'carpeta', 'con', 'corresponde', 'correspondiente', 'correspodiente', 'de', 'del',
  'dir', 'directorio', 'documento', 'donde', 'el', 'ella', 'en', 'entrega', 'entregar', 'envia', 'enviame',
  'enviar', 'envialo', 'esta', 'este', 'favor', 'file', 'for', 'from', 'guardado', 'home', 'in', 'la', 'las',
  'llama', 'llamado', 'llamano', 'lo', 'los', 'mi', 'mis', 'my', 'nombre', 'para', 'path', 'pdf', 'por',
  'porfavor', 'que', 'ruta', 'send', 'sube', 'subelo', 'subeme', 'subir', 'submit', 'tengo', 'the', 'to',
  'ubicada', 'ubicado', 'un', 'una', 'upload', 'via', 'y',
]);

const COURSE_STOP_WORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'en', 'y', 'e', 'para', 'con', 'a']);

const COURSE_LEADING_NOISE_WORDS = new Set(['sistemas', 'epis', 'unsa', 'escuela', 'curso']);

const COURSE_GROUP_KEYWORDS = new Set(['grupo', 'sec', 'seccion']);

const COURSE_NOISE_CODE = /^(?:\d{2}[ab]|\d{4}[ab]?|\d{4,}[a-z]?|\d+|g[a-z]|i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i;

const ACTIVITY_FAMILY = new Map<string, string>([
  ['laboratorio', 'laboratorio'],
  ['laboratorios', 'laboratorio'],
  ['lab', 'laboratorio'],
  ['labs', 'laboratorio'],
  ['practica', 'practica'],
  ['practicas', 'practica'],
  ['prac', 'practica'],
  ['tarea', 'tarea'],
  ['tareas', 'tarea'],
  ['actividad', 'actividad'],
  ['actividades', 'actividad'],
  ['trabajo', 'trabajo'],
  ['trabajos', 'trabajo'],
]);

export interface TaskMatchCandidate {
  task: TaskView;
  score: number;
  reasons: string[];
}

export interface TaskMatchResult {
  kind: 'exact' | 'ambiguous' | 'none';
  pdfHint: string | null;
  match: TaskMatchCandidate | null;
  candidates: TaskMatchCandidate[];
}

export interface LocalPdfEntry {
  path: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LocalPdfMatchCandidate {
  file: LocalPdfEntry;
  score: number;
  reasons: string[];
}

export interface LocalPdfMatchResult {
  kind: 'exact' | 'ambiguous' | 'none';
  match: LocalPdfMatchCandidate | null;
  candidates: LocalPdfMatchCandidate[];
}

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function tokenize(value: string): string[] {
  return stripDiacritics(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function splitCamelCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function tokenizeIdentifier(value: string): string[] {
  const spaced = splitCamelCase(value)
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  return tokenize(spaced);
}

function normalizeNumber(token: string): string | null {
  if (!/^\d+$/.test(token)) return null;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function addWordInitialAcronyms(words: readonly string[], target: Set<string>): void {
  if (words.length < 2) return;
  target.add(words.map((word) => word[0]!).join(''));
  for (let i = 0; i <= words.length - 2; i += 1) {
    target.add(`${words[i]![0]!}${words[i + 1]![0]!}`);
  }
  for (let i = 0; i <= words.length - 3; i += 1) {
    target.add(`${words[i]![0]!}${words[i + 1]![0]!}${words[i + 2]![0]!}`);
  }
}

function extractCoreCourseWords(raw: string, noiseMode: 'none' | 'leading' | 'all'): string[] {
  const tokens = tokenize(raw);
  const filtered: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (COURSE_GROUP_KEYWORDS.has(token)) {
      const next = tokens[i + 1];
      if (next && /^[a-z]$/.test(next)) {
        i += 1;
      }
      continue;
    }
    if (COURSE_STOP_WORDS.has(token) || COURSE_NOISE_CODE.test(token)) {
      continue;
    }
    if (noiseMode === 'all' && COURSE_LEADING_NOISE_WORDS.has(token)) {
      continue;
    }
    filtered.push(token);
  }

  if (noiseMode === 'leading') {
    let start = 0;
    while (start < filtered.length && COURSE_LEADING_NOISE_WORDS.has(filtered[start]!)) {
      start += 1;
    }
    return filtered.slice(start);
  }

  return filtered;
}

function courseAcronyms(course: string): Set<string> {
  const acronyms = new Set<string>();
  const colonIdx = course.lastIndexOf(':');
  const afterColon = colonIdx >= 0 ? course.slice(colonIdx + 1).trim() : '';

  if (afterColon) {
    addWordInitialAcronyms(extractCoreCourseWords(afterColon, 'none'), acronyms);
    addWordInitialAcronyms(extractCoreCourseWords(afterColon, 'all'), acronyms);
  }

  addWordInitialAcronyms(extractCoreCourseWords(course, 'leading'), acronyms);
  addWordInitialAcronyms(extractCoreCourseWords(course, 'all'), acronyms);

  return acronyms;
}

function collectActivityFamilies(tokens: readonly string[]): Set<string> {
  const families = new Set<string>();
  for (const token of tokens) {
    const family = ACTIVITY_FAMILY.get(token);
    if (family) families.add(family);
  }
  return families;
}

export function extractPdfHint(instruction: string): string | null {
  if (typeof instruction !== 'string' || !instruction.trim()) return null;
  const match = instruction.match(/(?:^|[\s"'`(\/\\])([^"'`\s\/\\<>|?*]+\.pdf)\b/i);
  return match?.[1]?.trim() || null;
}

interface ParsedQuery {
  tokens: string[];
  numbers: Set<string>;
  rawClean: string;
  queryAcronyms: Set<string>;
  subjectCues: string[];
}

function extractQueryTarget(instruction: string, pdfHint: string | null): ParsedQuery {
  let text = instruction;
  if (pdfHint) {
    text = text.replaceAll(pdfHint, ' ');
  }
  // Remove Unix/Windows path prefixes before the filename while preserving short course/folder tokens.
  const withoutExplicitPaths = text.replace(
    /(?:^|\s)(?:(?:en\s+la\s+)?(?:ruta|path|carpeta|directorio)\s+)?(?:~\/|\/|[a-zA-Z]:\\|home\/)[^\s"'`,;]+/gi,
    ' ',
  );
  text = text.replace(/~\/[^\s]+/g, (segment) => segment.replaceAll('/', ' '));
  const rawTokens = tokenize(text);
  const expandedTokens: string[] = [];

  for (const token of rawTokens) {
    const attached = token.match(/^([a-z]{2,})(\d+)$/);
    if (attached) {
      expandedTokens.push(attached[1]!, attached[2]!);
    } else {
      expandedTokens.push(token);
    }
  }

  const filtered: string[] = [];
  const numbers = new Set<string>();
  const fullCourseWords: string[] = [];

  for (const token of expandedTokens) {
    const num = normalizeNumber(token);
    if (num !== null) {
      numbers.add(num);
      filtered.push(num);
      continue;
    }
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    filtered.push(token);
    if (token.length >= 3 && !ACTIVITY_FAMILY.has(token) && !COURSE_NOISE_CODE.test(token)) {
      fullCourseWords.push(token);
    }
  }

  const subjectCues: string[] = [];
  for (const rawToken of tokenize(withoutExplicitPaths)) {
    const attached = rawToken.match(/^([a-z]{2,})(\d+)$/);
    const parts = attached ? [attached[1]!, attached[2]!] : [rawToken];
    for (const token of parts) {
      if (normalizeNumber(token) !== null) continue;
      if (token.length < 2 || STOP_WORDS.has(token) || ACTIVITY_FAMILY.has(token)) continue;
      subjectCues.push(token);
    }
  }

  const queryAcronyms = new Set<string>();
  addWordInitialAcronyms(fullCourseWords, queryAcronyms);

  return {
    tokens: [...new Set(filtered)],
    numbers,
    rawClean: stripDiacritics(text),
    queryAcronyms,
    subjectCues: [...new Set(subjectCues)],
  };
}

interface ScoredTask extends TaskMatchCandidate {
  hasNumberMismatch: boolean;
  subjectCueMatched: boolean;
}

function scoreTask(task: TaskView, query: ParsedQuery): ScoredTask {
  const titleTokens = tokenize(task.title);
  const courseTokens = tokenize(task.course);
  const titleNumbers = new Set(titleTokens.map(normalizeNumber).filter((v): v is string => v !== null));
  const titleSet = new Set(titleTokens);
  const courseSet = new Set(courseTokens);
  const titleActivityFamilies = collectActivityFamilies(titleTokens);
  const acronyms = courseAcronyms(task.course);
  const subjectCueSet = new Set(query.subjectCues);

  let score = 0;
  const reasons: string[] = [];
  let courseMatched = false;
  let titleMatched = false;
  let hasNumberMismatch = false;
  let subjectCueMatched = false;

  const cleanTitle = stripDiacritics(task.title).trim();
  if (cleanTitle.length >= 4 && query.rawClean.includes(cleanTitle)) {
    score += 45;
    titleMatched = true;
    subjectCueMatched = true;
    reasons.push('coincidencia de título completo');
  }

  for (const num of query.numbers) {
    if (titleNumbers.has(num)) {
      score += 28;
      titleMatched = true;
      reasons.push(`número ${num}`);
    } else if (titleNumbers.size > 0) {
      score -= 18;
      hasNumberMismatch = true;
    }
  }

  for (const token of query.tokens) {
    if (normalizeNumber(token) !== null) continue;
    if (acronyms.has(token)) {
      score += 36;
      courseMatched = true;
      if (subjectCueSet.has(token)) subjectCueMatched = true;
      reasons.push(`sigla de curso (${token.toUpperCase()})`);
      continue;
    }
    if (courseSet.has(token)) {
      score += 22;
      courseMatched = true;
      if (subjectCueSet.has(token)) subjectCueMatched = true;
      reasons.push(`curso (${token})`);
      continue;
    }
    if (titleSet.has(token)) {
      score += 18;
      titleMatched = true;
      if (subjectCueSet.has(token)) subjectCueMatched = true;
      reasons.push(`título (${token})`);
      continue;
    }
    const queryFamily = ACTIVITY_FAMILY.get(token);
    if (queryFamily && titleActivityFamilies.has(queryFamily)) {
      score += 18;
      titleMatched = true;
      reasons.push(`tipo de actividad (${token})`);
      continue;
    }
    if (queryFamily && titleActivityFamilies.size > 0) {
      score += 3;
      reasons.push(`tipo compatible (${token})`);
      continue;
    }
    if (token.length >= 4 && courseTokens.some((ct) => ct.startsWith(token))) {
      score += 14;
      courseMatched = true;
      if (subjectCueSet.has(token)) subjectCueMatched = true;
      reasons.push(`prefijo de curso (${token})`);
      continue;
    }
    if (token.length >= 4 && titleTokens.some((tt) => tt.startsWith(token))) {
      score += 12;
      titleMatched = true;
      if (subjectCueSet.has(token)) subjectCueMatched = true;
      reasons.push(`prefijo de título (${token})`);
    }
  }

  if (courseMatched && titleMatched) {
    score += 16;
  }

  return { task, score, reasons: [...new Set(reasons)], hasNumberMismatch, subjectCueMatched };
}

function toPublicTaskCandidate(candidate: ScoredTask): TaskMatchCandidate {
  return {
    task: candidate.task,
    score: candidate.score,
    reasons: candidate.reasons,
  };
}

export function matchTasksForCommand(tasks: readonly TaskView[], instruction: string): TaskMatchResult {
  const pdfHint = extractPdfHint(instruction);
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return { kind: 'none', pdfHint, match: null, candidates: [] };
  }

  const eligible = tasks.filter(
    (task) => task.destination === 'aula_virtual' && task.delivery?.state !== 'confirmed',
  );
  if (eligible.length === 0) {
    return { kind: 'none', pdfHint, match: null, candidates: [] };
  }

  const query = extractQueryTarget(instruction, pdfHint);
  if (query.tokens.length === 0 && query.numbers.size === 0) {
    return { kind: 'none', pdfHint, match: null, candidates: [] };
  }

  const scored = eligible
    .map((task) => scoreTask(task, query))
    .filter((candidate) => candidate.score >= 18)
    .sort((a, b) => b.score - a.score || a.task.title.localeCompare(b.task.title, 'es'));

  if (scored.length === 0) {
    return { kind: 'none', pdfHint, match: null, candidates: [] };
  }

  const best = scored[0]!;
  const second = scored[1];
  const isClearWinner = !second || best.score - second.score >= 15;
  const satisfiesSubject = query.subjectCues.length === 0 || best.subjectCueMatched;
  const publicCandidates = scored.slice(0, 5).map(toPublicTaskCandidate);
  if (isClearWinner && !best.hasNumberMismatch && satisfiesSubject && best.score >= 28) {
    return { kind: 'exact', pdfHint, match: publicCandidates[0]!, candidates: publicCandidates };
  }

  return { kind: 'ambiguous', pdfHint, match: null, candidates: publicCandidates };
}

function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '');
}

function extractSegmentAcronyms(segment: string): Set<string> {
  const acronyms = courseAcronyms(splitCamelCase(segment));
  const meaningful = tokenizeIdentifier(segment).filter(
    (token) =>
      token.length >= 2
      && normalizeNumber(token) === null
      && !COURSE_STOP_WORDS.has(token)
      && !ACTIVITY_FAMILY.has(token)
      && !COURSE_NOISE_CODE.test(token),
  );
  addWordInitialAcronyms(meaningful, acronyms);
  return acronyms;
}

interface ScoredLocalPdf extends LocalPdfMatchCandidate {
  exactFileMatched: boolean;
  hasNumberMismatch: boolean;
  subjectMatched: boolean;
}

function scoreLocalPdf(
  file: LocalPdfEntry,
  query: ParsedQuery,
  pdfHint: string | null,
): ScoredLocalPdf {
  const stem = stripPdfExtension(file.fileName);
  const fileTokens = tokenizeIdentifier(stem);
  const fileTokenSet = new Set(fileTokens);
  const fileNumbers = new Set(fileTokens.map(normalizeNumber).filter((v): v is string => v !== null));
  const fileFamilies = collectActivityFamilies(fileTokens);
  const fileAcronyms = extractSegmentAcronyms(stem);

  const pathParts = file.relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const folderSegments = pathParts.length > 1 ? pathParts.slice(0, -1) : [];
  const folderTokens: string[] = [];
  const folderAcronyms = new Set<string>();

  for (const segment of folderSegments) {
    for (const token of tokenizeIdentifier(segment)) {
      folderTokens.push(token);
    }
    for (const acr of extractSegmentAcronyms(segment)) {
      folderAcronyms.add(acr);
    }
  }

  const folderTokenSet = new Set(folderTokens);
  const folderNumbers = new Set(folderTokens.map(normalizeNumber).filter((v): v is string => v !== null));
  const subjectCueSet = new Set(query.subjectCues);

  let score = 0;
  const reasons: string[] = [];
  let exactFileMatched = false;
  let subjectMatched = false;
  let numberMatched = false;
  let hasNumberMismatch = false;
  let activityMatched = false;

  if (pdfHint) {
    const cleanHint = stripDiacritics(pdfHint);
    const cleanFileName = stripDiacritics(file.fileName);
    if (cleanFileName === cleanHint) {
      score += 120;
      exactFileMatched = true;
      reasons.push(`archivo exacto (${file.fileName})`);
    } else if (stripDiacritics(stem) === stripDiacritics(stripPdfExtension(pdfHint))) {
      score += 100;
      exactFileMatched = true;
      reasons.push(`nombre de archivo (${stem})`);
    }
  }

  for (const num of query.numbers) {
    if (fileNumbers.has(num)) {
      score += 30;
      numberMatched = true;
      reasons.push(`número ${num}`);
    } else if (fileNumbers.size > 0) {
      score -= 28;
      hasNumberMismatch = true;
    } else if (folderNumbers.has(num)) {
      score += 14;
      numberMatched = true;
      reasons.push(`número en carpeta ${num}`);
    }
  }

  for (const token of query.tokens) {
    if (normalizeNumber(token) !== null) continue;
    const queryFamily = ACTIVITY_FAMILY.get(token);

    if (fileTokenSet.has(token)) {
      score += 22;
      if (queryFamily) activityMatched = true;
      else if (subjectCueSet.has(token)) subjectMatched = true;
      reasons.push(`archivo (${token})`);
      if (folderTokenSet.has(token)) {
        score += 16;
        if (subjectCueSet.has(token)) subjectMatched = true;
        reasons.push(`carpeta (${token})`);
      }
      continue;
    }

    if (queryFamily && fileFamilies.has(queryFamily)) {
      score += 20;
      activityMatched = true;
      reasons.push(`tipo en archivo (${token})`);
      continue;
    }

    if (folderTokenSet.has(token)) {
      score += 20;
      if (subjectCueSet.has(token)) subjectMatched = true;
      reasons.push(`carpeta (${token})`);
      continue;
    }

    if (fileAcronyms.has(token) || folderAcronyms.has(token)) {
      score += 26;
      if (subjectCueSet.has(token)) subjectMatched = true;
      reasons.push(`sigla (${token.toUpperCase()})`);
      continue;
    }

    if (queryFamily && fileFamilies.size > 0) {
      score += 6;
      reasons.push(`tipo compatible (${token})`);
      continue;
    }

    if (token.length >= 4 && fileTokens.some((ft) => ft.startsWith(token))) {
      score += 12;
      if (queryFamily) activityMatched = true;
      else if (subjectCueSet.has(token)) subjectMatched = true;
      reasons.push(`prefijo de archivo (${token})`);
      continue;
    }

    if (token.length >= 4 && folderTokens.some((ft) => ft.startsWith(token))) {
      score += 12;
      if (subjectCueSet.has(token)) subjectMatched = true;
      reasons.push(`prefijo de carpeta (${token})`);
    }
  }

  if (!subjectMatched) {
    for (const qAcr of query.queryAcronyms) {
      if (fileTokenSet.has(qAcr) || folderTokenSet.has(qAcr)) {
        score += 24;
        subjectMatched = true;
        reasons.push(`sigla consulta (${qAcr.toUpperCase()})`);
        break;
      }
    }
  }

  if (subjectMatched && !hasNumberMismatch && (numberMatched || activityMatched || exactFileMatched)) {
    score += 14;
  }

  return { file, score, reasons: [...new Set(reasons)], exactFileMatched, hasNumberMismatch, subjectMatched };
}

function toPublicPdfCandidate(candidate: ScoredLocalPdf): LocalPdfMatchCandidate {
  return {
    file: candidate.file,
    score: candidate.score,
    reasons: candidate.reasons,
  };
}

export function matchLocalPdfFiles(
  files: readonly LocalPdfEntry[],
  query: string,
): LocalPdfMatchResult {
  if (files.length === 0 || typeof query !== 'string' || !query.trim()) {
    return { kind: 'none', match: null, candidates: [] };
  }

  const pdfHint = extractPdfHint(query);
  const parsed = extractQueryTarget(query, pdfHint);
  if (!pdfHint && parsed.tokens.length === 0 && parsed.numbers.size === 0) {
    return { kind: 'none', match: null, candidates: [] };
  }

  const scored = files
    .map((file) => scoreLocalPdf(file, parsed, pdfHint))
    .filter((candidate) => candidate.score >= 20)
    .sort(
      (a, b) =>
        b.score - a.score
        || b.file.modifiedAt.localeCompare(a.file.modifiedAt)
        || a.file.relativePath.localeCompare(b.file.relativePath, 'es'),
    );

  if (scored.length === 0) {
    return { kind: 'none', match: null, candidates: [] };
  }

  const best = scored[0]!;
  const second = scored[1];
  const isClearWinner = !second || best.score - second.score >= 15;
  const satisfiesExplicitHint = !pdfHint || best.exactFileMatched;
  const satisfiesNumber = best.exactFileMatched || !best.hasNumberMismatch;
  const satisfiesSubject = best.exactFileMatched || parsed.subjectCues.length === 0 || best.subjectMatched;
  const publicCandidates = scored.slice(0, 10).map(toPublicPdfCandidate);
  if (isClearWinner && satisfiesExplicitHint && satisfiesNumber && satisfiesSubject && best.score >= 34) {
    return { kind: 'exact', match: publicCandidates[0]!, candidates: publicCandidates };
  }

  return { kind: 'ambiguous', match: null, candidates: publicCandidates };
}
