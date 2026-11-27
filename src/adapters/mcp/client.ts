import { createHash } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_PDF_BYTES } from '../../core/application/tasks';
import {
  AgentDeliveryPolicy,
  AgentDeliveryProposal,
  AutoSyncStatus,
} from '../../core/domain/agent-automation';
import {
  LocalPdfEntry,
  LocalPdfMatchCandidate,
  LocalPdfMatchResult,
  matchLocalPdfFiles,
  TaskMatchCandidate,
  TaskMatchResult,
} from '../../core/domain/command-matcher';
import { DeliveryEvidence, PdfSummary, TaskView } from '../../core/domain/model';
import { NotePriority, NoteStatus } from '../../core/domain/personal-note';

const DEFAULT_PANEL_URL = 'http://127.0.0.1:3000';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 600;
const MIN_PDF_BYTES = 14;
const DEFAULT_MAX_SCAN_DEPTH = 4;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 4_000;
const DEFAULT_PDF_LIMIT = 20;
const MAX_PDF_LIMIT = 100;
const IGNORED_SCAN_DIRS = new Set(['.git', 'node_modules', 'dist']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASCII_DECODER = new TextDecoder('ascii');
const DATA_URI_PDF_PREFIX = /^data:application\/pdf;base64,/i;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const DEFAULT_WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..');

export interface ResolveLocalPanelUrlOptions {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FindLocalPdfsOptions {
  maxDepth?: number;
  limit?: number;
  sandboxRoot?: string;
}

export interface ReadHostPdfOptions {
  sandboxRoot?: string;
}

export interface ResolveDeliveryPdfTargetOptions {
  sandboxRoot?: string;
}

export interface AgentDiscardDeliveryResponse {
  jobId: string;
}

export interface FindLocalPdfsResult {
  resolvedDir: string;
  totalScanned: number;
  matchResult: LocalPdfMatchResult;
  files: LocalPdfEntry[];
}

export type ResolvedDeliveryPdfTarget =
  | { kind: 'file'; pdf: HostPdfFile; discoveredFromDir: string | null }
  | { kind: 'ambiguous_file'; resolvedDir: string; totalScanned: number; candidates: LocalPdfMatchCandidate[] }
  | { kind: 'no_file_match'; resolvedDir: string; totalScanned: number; files: LocalPdfEntry[] };

export interface HostPdfFile {
  resolvedPath: string;
  originalName: string;
  content: Buffer;
  sha256: string;
  sizeBytes: number;
}

export interface AgentSessionView {
  state: string;
  busy: boolean;
  message: string;
}

export interface AgentStatusCounts {
  pendingTasks: number;
  completedTasks: number;
  pendingProposals: number;
  pendingNotes: number;
}

export interface AgentStatusResponse {
  accountId: string;
  session: AgentSessionView | null;
  policy: AgentDeliveryPolicy;
  autoSync: AutoSyncStatus;
  counts: AgentStatusCounts;
}

export interface AgentTaskMatchSummary {
  kind: 'exact' | 'ambiguous' | 'none';
  pdfHint: string | null;
  candidates: TaskMatchCandidate[];
}

export interface AgentTasksResponse {
  accountId: string;
  tasks: TaskView[];
  match?: AgentTaskMatchSummary;
}

export interface AgentSyncResponse {
  jobId: string;
}

export interface AgentDeliverInput {
  pdf: HostPdfFile;
  instruction: string;
  taskId?: string;
  source?: string;
  executeIfAllowed?: boolean;
}

export interface AgentDeliverResponse {
  outcome: 'no_match' | 'ambiguous' | 'pending_confirmation' | 'authorized';
  policy: AgentDeliveryPolicy | string;
  pdfHint?: string | null;
  candidates?: TaskMatchCandidate[];
  proposal?: AgentDeliveryProposal;
  jobId?: string;
  task?: TaskView;
  pdf?: PdfSummary;
  panelUrl?: string;
}

export interface AgentAuthorizeProposalResponse {
  jobId: string;
  proposal: AgentDeliveryProposal;
}

export interface AgentJobStatusResponse {
  jobId: string;
  kind: 'search' | 'delivery';
  state: string;
  label: string;
  active: boolean;
  summary: string | null;
  evidence?: DeliveryEvidence | null;
  proofUrl?: string | null;
}

export interface AgentNoteItem {
  noteId: string;
  title: string;
  description: string;
  priority: NotePriority;
  deadline: string | null;
  status: NoteStatus;
}

export interface AgentNotesListResponse {
  accountId: string;
  notes: AgentNoteItem[];
}

export interface CreateAgentNoteInput {
  title: string;
  description?: string;
  priority: NotePriority;
  deadline?: string | null;
  status?: NoteStatus;
}

export interface CreateAgentNoteResponse {
  note: AgentNoteItem;
}

export interface WaitForJobOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface AulaPanelClientOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}

export class AulaPanelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AulaPanelError';
  }
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function encodePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..' || hasControlChars(trimmed)) {
    throw new AulaPanelError(`Identificador inválido para ${label}.`, undefined, 'invalid_identifier');
  }
  return encodeURIComponent(trimmed);
}

function readRuntimePanelUrl(workspaceDir: string): string {
  try {
    return readFileSync(path.join(workspaceDir, '.runtime-panel-url'), 'utf8').trim();
  } catch {
    return '';
  }
}

function parseDotEnvAppPort(content: string): string {
  let found = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?APP_PORT\s*=\s*(.+)$/);
    if (!match) continue;
    let value = match[1]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1).trim();
    } else {
      const commentIdx = value.indexOf('#');
      if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
    }
    if (value) found = value;
  }
  return found;
}

function readConfiguredAppPort(workspaceDir: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = (env.APP_PORT ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return parseDotEnvAppPort(readFileSync(path.join(workspaceDir, '.env'), 'utf8'));
  } catch {
    return '';
  }
}

function resolveCandidatePanelUrl(raw?: string, options?: ResolveLocalPanelUrlOptions): string {
  const explicit = (raw ?? '').trim();
  if (explicit) return explicit;

  const env = options?.env ?? process.env;
  const workspaceDir = options?.workspaceDir ?? DEFAULT_WORKSPACE_DIR;

  const fromEnvUrl = (env.AULA_PANEL_URL ?? '').trim();
  if (fromEnvUrl) return fromEnvUrl;

  const fromRuntimeFile = readRuntimePanelUrl(workspaceDir);
  if (fromRuntimeFile) return fromRuntimeFile;

  const configuredPort = readConfiguredAppPort(workspaceDir, env);
  if (configuredPort) {
    const parsedPort = Number.parseInt(configuredPort, 10);
    if (!/^\d{1,5}$/.test(configuredPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new AulaPanelError(
        `Puerto APP_PORT inválido ("${configuredPort}"). Debe estar entre 1 y 65535.`,
        undefined,
        'invalid_panel_url',
      );
    }
    return `http://127.0.0.1:${parsedPort}`;
  }

  return DEFAULT_PANEL_URL;
}

export function resolveLocalPanelUrl(raw?: string, options?: ResolveLocalPanelUrlOptions): string {
  const candidate = resolveCandidatePanelUrl(raw, options);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AulaPanelError(
      `URL del panel inválida ("${candidate}"). Solo se permite HTTP local en loopback (por ejemplo http://127.0.0.1:3000).`,
      undefined,
      'invalid_panel_url',
    );
  }

  if (parsed.protocol !== 'http:') {
    throw new AulaPanelError(
      `Protocolo no permitido ("${parsed.protocol}"). El cliente local solo acepta http:// en loopback (127.0.0.1, localhost o [::1]).`,
      undefined,
      'invalid_panel_url',
    );
  }

  if (parsed.username || parsed.password) {
    throw new AulaPanelError(
      'La URL del panel local no debe incluir credenciales embebidas.',
      undefined,
      'invalid_panel_url',
    );
  }

  if (parsed.search || parsed.hash) {
    throw new AulaPanelError(
      'La URL del panel local no debe incluir parámetros de consulta ni fragmentos.',
      undefined,
      'invalid_panel_url',
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new AulaPanelError(
      `Host remoto bloqueado ("${parsed.hostname}"). Por seguridad, el cliente solo se conecta a loopback (127.0.0.1, localhost o [::1]).`,
      undefined,
      'remote_host_blocked',
    );
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

export function expandUserPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new AulaPanelError('Indica una ruta de archivo válida.', undefined, 'invalid_path');
  }
  if (hasControlChars(rawPath)) {
    throw new AulaPanelError('La ruta del archivo contiene caracteres de control no permitidos.', undefined, 'invalid_path');
  }
  const trimmed = rawPath.trim();
  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  return path.resolve(expanded);
}

async function resolveCaseInsensitiveExistingPath(targetPath: string): Promise<string | null> {
  try {
    await lstat(targetPath);
    return targetPath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return targetPath;
    }
  }

  const root = path.parse(targetPath).root;
  const segments = targetPath.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;
    const direct = path.join(current, segment);

    try {
      const stats = await lstat(direct);
      if (!isLast && (stats.isSymbolicLink() || !stats.isDirectory())) {
        return null;
      }
      current = direct;
      continue;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        return null;
      }
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return null;
    }

    const lower = segment.toLowerCase();
    const matches = entries.filter((entry) => entry.name.toLowerCase() === lower);
    if (matches.length !== 1) {
      return null;
    }

    const matched = matches[0]!;
    if (!isLast && (matched.isSymbolicLink() || !matched.isDirectory())) {
      return null;
    }
    current = path.join(current, matched.name);
  }

  return current;
}

function isPathOutsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

async function resolveSandboxRoot(sandboxRoot: string): Promise<{ realRoot: string; configuredRoot: string }> {
  const trimmedRoot = sandboxRoot.trim();
  if (!trimmedRoot || hasControlChars(sandboxRoot)) {
    throw new AulaPanelError('La configuración del directorio sandbox es inválida.', undefined, 'sandbox_unavailable');
  }
  const configuredRoot = path.resolve(trimmedRoot);
  let realRoot: string;
  try {
    realRoot = await realpath(configuredRoot);
  } catch {
    throw new AulaPanelError(
      `El directorio sandbox "${sandboxRoot}" no está disponible.`,
      undefined,
      'sandbox_unavailable',
    );
  }

  let rootStats;
  try {
    rootStats = await lstat(realRoot);
  } catch {
    throw new AulaPanelError(
      `No se pudo inspeccionar el directorio sandbox "${sandboxRoot}".`,
      undefined,
      'sandbox_unavailable',
    );
  }
  if (!rootStats.isDirectory()) {
    throw new AulaPanelError(
      `La ruta sandbox "${sandboxRoot}" no corresponde a un directorio.`,
      undefined,
      'sandbox_unavailable',
    );
  }

  return { realRoot, configuredRoot };
}

async function rejectSandboxedSymlink(rawPath: string, candidatePath: string, realRoot: string): Promise<never> {
  const targetReal = await realpath(candidatePath).catch(() => null);
  if (!targetReal || isPathOutsideRoot(realRoot, targetReal)) {
    throw new AulaPanelError(
      `Se rechazó "${rawPath}" porque el enlace simbólico sale del directorio sandbox permitido.`,
      undefined,
      'outside_sandbox',
    );
  }
  throw new AulaPanelError(
    `Se rechazó "${rawPath}" porque es un enlace simbólico. Usa la ruta directa dentro del inbox.`,
    undefined,
    'symlink_rejected',
  );
}

async function resolveSandboxedPath(rawPath: string, sandboxRoot: string): Promise<string> {
  if (typeof rawPath !== 'string' || hasControlChars(rawPath)) {
    throw new AulaPanelError('La ruta del archivo contiene caracteres de control no permitidos.', undefined, 'invalid_path');
  }

  const { realRoot, configuredRoot } = await resolveSandboxRoot(sandboxRoot);
  const trimmed = rawPath.trim();

  if (trimmed.split(/[\\/]+/).includes('..')) {
    throw new AulaPanelError(
      `Ruta rechazada ("${trimmed}"): no se permite salir del directorio sandbox "${sandboxRoot}".`,
      undefined,
      'outside_sandbox',
    );
  }

  if (trimmed.includes('\\')) {
    throw new AulaPanelError(
      `Ruta rechazada ("${trimmed}"): usa separadores "/" relativos al directorio sandbox.`,
      undefined,
      'outside_sandbox',
    );
  }

  if (trimmed === '~' || trimmed.startsWith('~/')) {
    throw new AulaPanelError(
      `Ruta rechazada ("${trimmed}"): el acceso a carpetas del equipo anfitrión está deshabilitado en modo sandbox.`,
      undefined,
      'outside_sandbox',
    );
  }

  let relativeSegments: string[] = [];
  if (trimmed === '' || trimmed === '.' || trimmed === './' || trimmed === '/') {
    relativeSegments = [];
  } else if (trimmed.startsWith('/')) {
    const normalizedAbs = path.resolve(trimmed);
    if (!isPathOutsideRoot(configuredRoot, normalizedAbs)) {
      const rel = path.relative(configuredRoot, normalizedAbs);
      relativeSegments = rel ? rel.split(path.sep).filter(Boolean) : [];
    } else if (!isPathOutsideRoot(realRoot, normalizedAbs)) {
      const rel = path.relative(realRoot, normalizedAbs);
      relativeSegments = rel ? rel.split(path.sep).filter(Boolean) : [];
    } else if (normalizedAbs === '/inbox' || normalizedAbs.startsWith('/inbox/')) {
      const rel = path.relative('/inbox', normalizedAbs);
      relativeSegments = rel ? rel.split(path.sep).filter(Boolean) : [];
    } else {
      throw new AulaPanelError(
        `Ruta rechazada ("${trimmed}"): fuera del directorio sandbox "${sandboxRoot}". Usa una ruta relativa dentro del inbox o envía el PDF en Base64.`,
        undefined,
        'outside_sandbox',
      );
    }
  } else {
    const candidate = path.resolve(realRoot, trimmed);
    if (isPathOutsideRoot(realRoot, candidate)) {
      throw new AulaPanelError(
        `Ruta rechazada ("${trimmed}"): fuera del directorio sandbox "${sandboxRoot}".`,
        undefined,
        'outside_sandbox',
      );
    }
    const rel = path.relative(realRoot, candidate);
    relativeSegments = rel ? rel.split(path.sep).filter(Boolean) : [];
  }

  let current = realRoot;
  for (let i = 0; i < relativeSegments.length; i += 1) {
    const segment = relativeSegments[i]!;
    const isLast = i === relativeSegments.length - 1;
    const direct = path.join(current, segment);

    try {
      const stats = await lstat(direct);
      if (stats.isSymbolicLink()) {
        await rejectSandboxedSymlink(rawPath, direct, realRoot);
      }
      if (!isLast && !stats.isDirectory()) {
        current = path.join(current, ...relativeSegments.slice(i));
        break;
      }
      current = direct;
      continue;
    } catch (error) {
      if (error instanceof AulaPanelError) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        current = path.join(current, ...relativeSegments.slice(i));
        break;
      }
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      current = path.join(current, ...relativeSegments.slice(i));
      break;
    }

    const lower = segment.toLowerCase();
    const matches = entries.filter((entry) => entry.name.toLowerCase() === lower);
    if (matches.length !== 1) {
      current = path.join(current, ...relativeSegments.slice(i));
      break;
    }

    const matched = matches[0]!;
    const matchedPath = path.join(current, matched.name);
    let matchedStats;
    try {
      matchedStats = await lstat(matchedPath);
    } catch {
      current = path.join(current, ...relativeSegments.slice(i));
      break;
    }
    if (matched.isSymbolicLink() || matchedStats.isSymbolicLink()) {
      await rejectSandboxedSymlink(rawPath, matchedPath, realRoot);
    }
    if (!isLast && !matchedStats.isDirectory()) {
      current = path.join(current, ...relativeSegments.slice(i));
      break;
    }
    current = matchedPath;
  }

  if (isPathOutsideRoot(realRoot, current)) {
    throw new AulaPanelError(
      `Ruta rechazada ("${trimmed}"): fuera del directorio sandbox "${sandboxRoot}".`,
      undefined,
      'outside_sandbox',
    );
  }

  return current;
}

export async function resolveUserPath(rawPath: string, sandboxRoot?: string): Promise<string> {
  if (sandboxRoot !== undefined) {
    return resolveSandboxedPath(rawPath, sandboxRoot);
  }

  const expanded = expandUserPath(rawPath);
  const direct = await resolveCaseInsensitiveExistingPath(expanded);
  if (direct !== null) {
    return direct;
  }

  const trimmed = rawPath.trim();
  const isBareHomeRelative =
    !trimmed.startsWith('/')
    && !trimmed.startsWith('~')
    && !trimmed.startsWith('.')
    && /^home(?:\/|$)/i.test(trimmed)
    && !trimmed.split('/').includes('..');

  if (isBareHomeRelative) {
    const rootCandidate = path.resolve('/', trimmed);
    const fromRoot = await resolveCaseInsensitiveExistingPath(rootCandidate);
    if (fromRoot !== null) {
      return fromRoot;
    }
  }

  return expanded;
}

export async function findLocalPdfs(
  searchDir: string,
  query?: string,
  options: FindLocalPdfsOptions = {},
): Promise<FindLocalPdfsResult> {
  const resolvedDir = await resolveUserPath(searchDir, options.sandboxRoot);
  let rootStats;
  try {
    rootStats = await lstat(resolvedDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new AulaPanelError(`No se encontró el directorio "${resolvedDir}".`, undefined, 'dir_not_found');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AulaPanelError(`Sin permisos para leer el directorio "${resolvedDir}".`, undefined, 'permission_denied');
    }
    throw new AulaPanelError(
      `No se pudo inspeccionar el directorio "${resolvedDir}": ${error instanceof Error ? error.message : 'error desconocido'}.`,
      undefined,
      'dir_open_failed',
    );
  }

  if (rootStats.isSymbolicLink()) {
    throw new AulaPanelError(
      `Se rechazó "${resolvedDir}" porque es un enlace simbólico. Indica una carpeta real.`,
      undefined,
      'symlink_rejected',
    );
  }
  if (!rootStats.isDirectory()) {
    throw new AulaPanelError(
      `La ruta "${resolvedDir}" no corresponde a un directorio.`,
      undefined,
      'not_a_directory',
    );
  }

  const maxDepth = Math.max(0, Math.min(MAX_SCAN_DEPTH, Math.trunc(options.maxDepth ?? DEFAULT_MAX_SCAN_DEPTH)));
  const limit = Math.max(1, Math.min(MAX_PDF_LIMIT, Math.trunc(options.limit ?? DEFAULT_PDF_LIMIT)));

  const queue: Array<{ dir: string; depth: number }> = [{ dir: resolvedDir, depth: 0 }];
  const collected: LocalPdfEntry[] = [];
  let totalScanned = 0;

  while (queue.length > 0 && totalScanned < MAX_SCAN_ENTRIES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      if (current.depth === 0) {
        throw new AulaPanelError(
          `Sin permisos para listar el directorio "${resolvedDir}": ${error instanceof Error ? error.message : 'error desconocido'}.`,
          undefined,
          'permission_denied',
        );
      }
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, 'es'));

    for (const entry of entries) {
      if (totalScanned >= MAX_SCAN_ENTRIES) break;
      totalScanned += 1;

      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_SCAN_DIRS.has(entry.name)) continue;
        if (current.depth < maxDepth) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.pdf')) {
        continue;
      }

      let fileStats;
      try {
        fileStats = await lstat(fullPath);
      } catch {
        continue;
      }

      if (!fileStats.isFile() || fileStats.isSymbolicLink()) continue;
      if (fileStats.size < MIN_PDF_BYTES || fileStats.size > MAX_PDF_BYTES) continue;

      collected.push({
        path: fullPath,
        fileName: entry.name,
        relativePath: path.relative(resolvedDir, fullPath).split(path.sep).join('/'),
        sizeBytes: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    }
  }

  const cleanQuery = typeof query === 'string' ? query.trim() : '';
  if (cleanQuery) {
    const rawMatch = matchLocalPdfFiles(collected, cleanQuery);
    const candidates = rawMatch.candidates.slice(0, limit);
    return {
      resolvedDir,
      totalScanned,
      matchResult: {
        kind: rawMatch.kind,
        match: rawMatch.match,
        candidates,
      },
      files: candidates.map((candidate) => candidate.file),
    };
  }

  const sortedFiles = [...collected]
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.relativePath.localeCompare(b.relativePath, 'es'))
    .slice(0, limit);

  return {
    resolvedDir,
    totalScanned,
    matchResult: { kind: 'none', match: null, candidates: [] },
    files: sortedFiles,
  };
}

function validatePdfBuffer(content: Buffer, originalName: string): void {
  if (content.byteLength < MIN_PDF_BYTES || content.byteLength > MAX_PDF_BYTES) {
    throw new AulaPanelError(
      `El archivo "${originalName}" debe tener entre ${MIN_PDF_BYTES} bytes y 20 MiB (actual: ${content.byteLength} bytes).`,
      undefined,
      'invalid_pdf',
    );
  }

  const header = ASCII_DECODER.decode(content.subarray(0, 10));
  const trailer = ASCII_DECODER.decode(content.subarray(-1024));
  if (!/^%PDF-[12]\.\d(?:\r|\n)/.test(header) || !trailer.trimEnd().endsWith('%%EOF')) {
    throw new AulaPanelError(
      `El archivo "${originalName}" no tiene cabecera %PDF- y cierre %%EOF válidos.`,
      undefined,
      'invalid_pdf',
    );
  }
}

export function parseBase64Pdf(base64: string, fileName: string): HostPdfFile {
  if (typeof fileName !== 'string' || hasControlChars(fileName)) {
    throw new AulaPanelError('El nombre del archivo PDF no es válido.', undefined, 'invalid_pdf');
  }
  const cleanName = fileName.trim();
  if (
    !cleanName
    || cleanName.length > 255
    || !/\.pdf$/i.test(cleanName)
    || cleanName.toLowerCase() === '.pdf'
    || cleanName.includes('/')
    || cleanName.includes('\\')
    || cleanName.includes('..')
  ) {
    throw new AulaPanelError(
      'El nombre del archivo PDF debe terminar en ".pdf" y no contener rutas ("/", "\\", "..") ni caracteres de control.',
      undefined,
      'invalid_pdf',
    );
  }

  if (typeof base64 !== 'string') {
    throw new AulaPanelError('El contenido "pdfBase64" debe ser una cadena Base64 válida.', undefined, 'invalid_pdf');
  }

  // Bound raw string length before whitespace stripping to prevent oversized allocations over STDIO.
  if (base64.length > MAX_BASE64_CHARS + 1024 * 1024) {
    throw new AulaPanelError(
      `El archivo "${cleanName}" supera el límite máximo permitido de 20 MiB.`,
      undefined,
      'invalid_pdf',
    );
  }

  const trimmed = base64.trim();
  const withoutPrefix = DATA_URI_PDF_PREFIX.test(trimmed)
    ? trimmed.replace(DATA_URI_PDF_PREFIX, '')
    : trimmed;
  const compact = withoutPrefix.replace(/\s+/g, '');

  if (!compact) {
    throw new AulaPanelError(
      `El contenido Base64 de "${cleanName}" no es válido.`,
      undefined,
      'invalid_pdf',
    );
  }

  if (compact.length > MAX_BASE64_CHARS) {
    throw new AulaPanelError(
      `El archivo "${cleanName}" supera el límite máximo permitido de 20 MiB.`,
      undefined,
      'invalid_pdf',
    );
  }

  if (compact.length % 4 !== 0 || !STRICT_BASE64_PATTERN.test(compact)) {
    throw new AulaPanelError(
      `El contenido Base64 de "${cleanName}" no es válido.`,
      undefined,
      'invalid_pdf',
    );
  }

  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const estimatedBytes = (compact.length / 4) * 3 - padding;
  if (estimatedBytes < MIN_PDF_BYTES || estimatedBytes > MAX_PDF_BYTES) {
    throw new AulaPanelError(
      `El archivo "${cleanName}" debe tener entre ${MIN_PDF_BYTES} bytes y 20 MiB (actual: ${estimatedBytes} bytes).`,
      undefined,
      'invalid_pdf',
    );
  }

  const content = Buffer.from(compact, 'base64');
  validatePdfBuffer(content, cleanName);

  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    resolvedPath: `inline://${cleanName}`,
    originalName: cleanName,
    content,
    sha256,
    sizeBytes: content.byteLength,
  };
}

function extractSandboxRoot(sandboxRootOrOptions?: string | { sandboxRoot?: string }): string | undefined {
  if (typeof sandboxRootOrOptions === 'string') return sandboxRootOrOptions;
  return sandboxRootOrOptions?.sandboxRoot;
}

export async function readHostPdf(
  filePath: string,
  sandboxRootOrOptions?: string | ReadHostPdfOptions,
): Promise<HostPdfFile> {
  const sandboxRoot = extractSandboxRoot(sandboxRootOrOptions);
  const resolvedPath = await resolveUserPath(filePath, sandboxRoot);
  const originalName = path.basename(resolvedPath);
  if (
    !originalName.trim()
    || originalName.length > 255
    || originalName.includes('/')
    || originalName.includes('\\')
    || hasControlChars(originalName)
  ) {
    throw new AulaPanelError('El nombre del archivo PDF no es válido.', undefined, 'invalid_pdf');
  }

  let handle;
  try {
    handle = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new AulaPanelError(`No se encontró el archivo PDF en "${resolvedPath}".`, undefined, 'file_not_found');
    }
    if (code === 'ELOOP') {
      throw new AulaPanelError(
        `Se rechazó "${resolvedPath}" porque es un enlace simbólico. Usa la ruta directa del archivo PDF.`,
        undefined,
        'symlink_rejected',
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AulaPanelError(`Sin permisos para leer el archivo "${resolvedPath}".`, undefined, 'permission_denied');
    }
    throw new AulaPanelError(
      `No se pudo abrir el archivo "${resolvedPath}": ${error instanceof Error ? error.message : 'error desconocido'}.`,
      undefined,
      'file_open_failed',
    );
  }

  let content: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new AulaPanelError(`La ruta "${resolvedPath}" no corresponde a un archivo regular.`, undefined, 'invalid_pdf');
    }
    if (stats.size < MIN_PDF_BYTES || stats.size > MAX_PDF_BYTES) {
      throw new AulaPanelError(
        `El archivo "${originalName}" debe tener entre ${MIN_PDF_BYTES} bytes y 20 MiB (actual: ${stats.size} bytes).`,
        undefined,
        'invalid_pdf',
      );
    }
    content = await handle.readFile();
  } finally {
    await handle.close();
  }

  validatePdfBuffer(content, originalName);

  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    resolvedPath,
    originalName,
    content,
    sha256,
    sizeBytes: content.byteLength,
  };
}

export async function resolveDeliveryPdfTarget(
  filePath: string,
  instruction: string,
  sandboxRootOrOptions?: string | ResolveDeliveryPdfTargetOptions,
): Promise<ResolvedDeliveryPdfTarget> {
  const sandboxRoot = extractSandboxRoot(sandboxRootOrOptions);
  const resolved = await resolveUserPath(filePath, sandboxRoot);
  let stats = null;
  try {
    stats = await lstat(resolved);
  } catch {
    // Let readHostPdf emit the canonical file_not_found / permission_denied error.
  }

  if (stats && !stats.isSymbolicLink() && stats.isDirectory()) {
    const found = await findLocalPdfs(resolved, instruction, { sandboxRoot });
    if (found.matchResult.kind === 'none') {
      return {
        kind: 'no_file_match',
        resolvedDir: found.resolvedDir,
        totalScanned: found.totalScanned,
        files: found.files,
      };
    }
    if (found.matchResult.kind === 'ambiguous' || !found.matchResult.match) {
      return {
        kind: 'ambiguous_file',
        resolvedDir: found.resolvedDir,
        totalScanned: found.totalScanned,
        candidates: found.matchResult.candidates,
      };
    }
    const pdf = await readHostPdf(found.matchResult.match.file.path, sandboxRoot);
    return {
      kind: 'file',
      pdf,
      discoveredFromDir: found.resolvedDir,
    };
  }

  const pdf = await readHostPdf(resolved, sandboxRoot);
  return {
    kind: 'file',
    pdf,
    discoveredFromDir: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return `Error HTTP ${response.status} del panel local.`;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    if (Array.isArray(parsed.message) && parsed.message.length > 0) {
      return parsed.message.map(String).join('; ');
    }
  } catch {
    // Non-JSON response body; fall back to bounded plain text.
  }
  return text.trim().slice(0, 300);
}

export class AulaPanelClient {
  private readonly explicitBaseUrl?: string;
  private readonly resolveOptions?: ResolveLocalPanelUrlOptions;
  private readonly requestTimeoutMs: number;

  constructor(baseUrlOrOptions?: string | AulaPanelClientOptions) {
    const options: AulaPanelClientOptions = typeof baseUrlOrOptions === 'string'
      ? { baseUrl: baseUrlOrOptions }
      : (baseUrlOrOptions ?? {});
    this.explicitBaseUrl = options.baseUrl?.trim() || undefined;
    this.resolveOptions = options.workspaceDir || options.env
      ? { workspaceDir: options.workspaceDir, env: options.env }
      : undefined;
    // Validate initial panel URL configuration eagerly so invalid URLs fail fast.
    resolveLocalPanelUrl(this.explicitBaseUrl, this.resolveOptions);
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  get baseUrl(): string {
    return resolveLocalPanelUrl(this.explicitBaseUrl, this.resolveOptions);
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const currentBaseUrl = this.baseUrl;
    const url = `${currentBaseUrl}${pathname}`;
    try {
      return await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof AulaPanelError) throw error;
      const reason = error instanceof Error ? error.message : 'error de red';
      throw new AulaPanelError(
        `No se pudo conectar con el panel local en ${currentBaseUrl} (${reason}). Verifica que el contenedor/servicio esté iniciado.`,
        undefined,
        'panel_unreachable',
      );
    }
  }

  private async requestJson<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    const response = await this.request(pathname, { ...init, headers });
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw new AulaPanelError(message, response.status, 'http_error');
    }
    try {
      return await response.json() as T;
    } catch {
      throw new AulaPanelError(
        `El panel local devolvió una respuesta no JSON en ${pathname}.`,
        response.status,
        'invalid_json',
      );
    }
  }

  getStatus(): Promise<AgentStatusResponse> {
    return this.requestJson<AgentStatusResponse>('/api/agente/estado');
  }

  listTasks(query?: string): Promise<AgentTasksResponse> {
    const clean = typeof query === 'string' ? query.trim() : '';
    const suffix = clean ? `?q=${encodeURIComponent(clean)}` : '';
    return this.requestJson<AgentTasksResponse>(`/api/agente/tareas${suffix}`);
  }

  analyzeInstruction(instruction: string): Promise<TaskMatchResult> {
    return this.requestJson<TaskMatchResult>('/api/agente/analizar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
  }

  triggerSync(): Promise<AgentSyncResponse> {
    return this.requestJson<AgentSyncResponse>('/api/agente/sincronizar', {
      method: 'POST',
    });
  }

  deliverPdf(input: AgentDeliverInput): Promise<AgentDeliverResponse> {
    const form = new FormData();
    form.append('pdf', new Blob([new Uint8Array(input.pdf.content)], { type: 'application/pdf' }), input.pdf.originalName);
    form.append('instruction', input.instruction);
    if (input.taskId && input.taskId.trim()) {
      form.append('taskId', input.taskId.trim());
    }
    form.append('source', input.source?.trim() || 'ai-mcp');
    form.append('executeIfAllowed', input.executeIfAllowed ? 'true' : 'false');

    return this.requestJson<AgentDeliverResponse>('/api/agente/entregas', {
      method: 'POST',
      body: form,
    });
  }

  authorizeProposal(proposalId: string): Promise<AgentAuthorizeProposalResponse> {
    const encoded = encodePathSegment(proposalId, 'proposalId');
    return this.requestJson<AgentAuthorizeProposalResponse>(`/api/agente/propuestas/${encoded}/autorizar`, {
      method: 'POST',
    });
  }

  discardDelivery(taskId: string, jobId: string): Promise<AgentDiscardDeliveryResponse> {
    const encodedTaskId = encodePathSegment(taskId, 'taskId');
    const encodedJobId = encodePathSegment(jobId, 'jobId');
    return this.requestJson<AgentDiscardDeliveryResponse>(
      `/api/agente/tareas/${encodedTaskId}/entregas/${encodedJobId}`,
      { method: 'DELETE' },
    );
  }

  getJob(jobId: string): Promise<AgentJobStatusResponse> {
    const encoded = encodePathSegment(jobId, 'jobId');
    return this.requestJson<AgentJobStatusResponse>(`/api/agente/trabajos/${encoded}`);
  }

  async waitForJob(jobId: string, options: WaitForJobOptions = {}): Promise<AgentJobStatusResponse> {
    const timeoutMs = Math.max(10, options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
    const deadline = Date.now() + timeoutMs;

    let latest = await this.getJob(jobId);
    while (latest.active) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AulaPanelError(
          `El trabajo ${jobId} sigue en progreso (estado: ${latest.state}) tras esperar ${Math.round(timeoutMs / 1000)} s. Consulta su estado nuevamente con aula_check_job.`,
          undefined,
          'job_wait_timeout',
        );
      }
      await sleep(Math.min(pollMs, remaining));
      latest = await this.getJob(jobId);
    }
    return latest;
  }

  async fetchProofPng(jobId: string): Promise<Buffer | null> {
    const encoded = encodePathSegment(jobId, 'jobId');
    const response = await this.request(`/entregas/${encoded}/captura`, {
      method: 'GET',
      headers: { accept: 'image/png' },
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw new AulaPanelError(message, response.status, 'http_error');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
      throw new AulaPanelError(
        `La captura recibida para el trabajo ${jobId} no es una imagen PNG válida.`,
        response.status,
        'invalid_png',
      );
    }
    return bytes;
  }

  listNotes(): Promise<AgentNotesListResponse> {
    return this.requestJson<AgentNotesListResponse>('/api/agente/notas');
  }

  createNote(input: CreateAgentNoteInput): Promise<CreateAgentNoteResponse> {
    const payload: Record<string, unknown> = {
      title: input.title,
      priority: input.priority,
    };
    if (input.description !== undefined) payload.description = input.description;
    if (input.deadline !== undefined) payload.deadline = input.deadline;
    if (input.status !== undefined) payload.status = input.status;

    return this.requestJson<CreateAgentNoteResponse>('/api/agente/notas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
