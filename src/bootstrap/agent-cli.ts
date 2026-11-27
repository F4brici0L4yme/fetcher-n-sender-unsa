#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AulaPanelClient,
  expandUserPath,
  findLocalPdfs,
  resolveDeliveryPdfTarget,
  WaitForJobOptions,
} from '../adapters/mcp/client';
import { NotePriority } from '../core/domain/personal-note';

export interface AgentCliOptions {
  baseUrl?: string;
  waitOptions?: WaitForJobOptions;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  'url',
  'dir',
  'max-depth',
  'limit',
  'query',
  'file',
  'instruction',
  'task',
  'proof-out',
  'title',
  'priority',
  'description',
  'deadline',
  'source',
]);

const BOOLEAN_FLAGS = new Set(['wait', 'help', 'h']);

const USAGE_TEXT = [
  'Uso: aula-agent <comando> [opciones]',
  '',
  'Comandos:',
  '  status',
  '  tasks [--query "<consulta>"]',
  '  sync [--wait]',
  '  find --dir <carpeta> [--query "<consulta>"] [--max-depth <n>] [--limit <n>]',
  '  deliver --file <ruta.pdf|carpeta> --instruction "<texto>" [--task <uuid>] [--source <agente>] [--wait] [--proof-out <ruta.png>]',
  '  job <jobId> [--wait] [--proof-out <ruta.png>]',
  '  notes list',
  '  notes create --title "<título>" --priority <alta|media|baja> [--description "<texto>"] [--deadline "<fecha>"]',
  '',
  'Opciones globales:',
  '  --url <http://127.0.0.1:PUERTO> URL loopback del panel (autodetecta AULA_PANEL_URL, .runtime-panel-url, APP_PORT/.env o :3000)',
  '  -h, --help                      Muestra esta ayuda',
].join('\n');

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const eqIndex = token.indexOf('=');
    const rawName = eqIndex >= 0 ? token.slice(2, eqIndex) : token.slice(2);
    if (!rawName) {
      throw new Error('Opción vacía ("--") no válida.');
    }

    if (BOOLEAN_FLAGS.has(rawName)) {
      if (eqIndex >= 0) {
        const rawVal = token.slice(eqIndex + 1).toLowerCase();
        if (rawVal === 'true' || rawVal === '1') flags.set(rawName, true);
        else if (rawVal === 'false' || rawVal === '0') flags.set(rawName, false);
        else throw new Error(`Valor booleano inválido para --${rawName}: "${rawVal}".`);
      } else {
        flags.set(rawName, true);
      }
      continue;
    }

    if (VALUE_FLAGS.has(rawName)) {
      if (eqIndex >= 0) {
        flags.set(rawName, token.slice(eqIndex + 1));
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`Falta el valor para la opción --${rawName}.`);
        }
        flags.set(rawName, next);
        i += 1;
      }
      continue;
    }

    throw new Error(`Opción desconocida: --${rawName}. Usa --help para ver las opciones disponibles.`);
  }

  return { positionals, flags };
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function getRequiredFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = getStringFlag(flags, name);
  if (!value || !value.trim()) {
    throw new Error(`Falta la opción obligatoria --${name}.`);
  }
  return value.trim();
}

function getBoolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function getOptionalIntFlag(
  flags: Map<string, string | boolean>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = getStringFlag(flags, name);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`El valor de --${name} debe ser un número entero entre ${min} y ${max}.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`El valor de --${name} debe estar entre ${min} y ${max}.`);
  }
  return parsed;
}

function parsePriority(raw: string): NotePriority {
  if (raw === 'alta' || raw === 'media' || raw === 'baja') {
    return raw;
  }
  throw new Error('La prioridad (--priority) debe ser "alta", "media" o "baja".');
}

async function saveProofPng(client: AulaPanelClient, jobId: string, proofOut: string): Promise<string | null> {
  const png = await client.fetchProofPng(jobId);
  if (!png) return null;
  const resolved = expandUserPath(proofOut);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, png);
  return resolved;
}

export async function runAgentCli(
  argv: readonly string[],
  options: AgentCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const waitOptions = options.waitOptions ?? {};

  try {
    const { positionals, flags } = parseArgs(argv);
    if (getBoolFlag(flags, 'help') || positionals.length === 0) {
      stdout(USAGE_TEXT);
      return positionals.length === 0 && !getBoolFlag(flags, 'help') ? 1 : 0;
    }

    const command = positionals[0]!;

    if (command === 'find') {
      const searchDir = getRequiredFlag(flags, 'dir');
      const query = getStringFlag(flags, 'query');
      const maxDepth = getOptionalIntFlag(flags, 'max-depth', 0, 8);
      const limit = getOptionalIntFlag(flags, 'limit', 1, 100);
      const found = await findLocalPdfs(searchDir, query, { maxDepth, limit });
      stdout(JSON.stringify(found, null, 2));
      return 0;
    }

    const client = new AulaPanelClient(getStringFlag(flags, 'url') ?? options.baseUrl);

    if (command === 'status') {
      const status = await client.getStatus();
      stdout(JSON.stringify(status, null, 2));
      return 0;
    }

    if (command === 'tasks') {
      const tasks = await client.listTasks(getStringFlag(flags, 'query'));
      stdout(JSON.stringify(tasks, null, 2));
      return 0;
    }

    if (command === 'sync') {
      const sync = await client.triggerSync();
      if (getBoolFlag(flags, 'wait')) {
        const job = await client.waitForJob(sync.jobId, waitOptions);
        stdout(JSON.stringify({ jobId: sync.jobId, job }, null, 2));
      } else {
        stdout(JSON.stringify(sync, null, 2));
      }
      return 0;
    }

    if (command === 'deliver') {
      const filePath = getRequiredFlag(flags, 'file');
      const instruction = getRequiredFlag(flags, 'instruction');
      const taskId = getStringFlag(flags, 'task');
      const source = getStringFlag(flags, 'source') ?? 'agent-cli';
      const proofOut = getStringFlag(flags, 'proof-out');
      const wait = getBoolFlag(flags, 'wait') || Boolean(proofOut);

      const resolvedTarget = await resolveDeliveryPdfTarget(filePath, instruction);
      if (resolvedTarget.kind === 'no_file_match') {
        throw new Error(
          `No se encontró ningún archivo PDF que coincida con la instrucción dentro de "${resolvedTarget.resolvedDir}". Usa "aula-agent find --dir ..." para listar los PDFs disponibles.`,
        );
      }
      if (resolvedTarget.kind === 'ambiguous_file') {
        stdout(JSON.stringify({
          outcome: 'ambiguous_file',
          resolvedDir: resolvedTarget.resolvedDir,
          totalScanned: resolvedTarget.totalScanned,
          candidates: resolvedTarget.candidates,
        }, null, 2));
        return 0;
      }

      const result = await client.deliverPdf({
        pdf: resolvedTarget.pdf,
        instruction,
        taskId,
        source,
        executeIfAllowed: true,
      });

      if (result.outcome === 'authorized' && result.jobId && wait) {
        const job = await client.waitForJob(result.jobId, waitOptions);
        let proofSavedTo: string | null = null;
        if (proofOut && job.proofUrl) {
          proofSavedTo = await saveProofPng(client, result.jobId, proofOut);
        }
        stdout(JSON.stringify({
          ...result,
          resolvedFilePath: resolvedTarget.pdf.resolvedPath,
          job,
          ...(proofSavedTo ? { proofSavedTo } : {}),
        }, null, 2));
        return 0;
      }

      stdout(JSON.stringify({ ...result, resolvedFilePath: resolvedTarget.pdf.resolvedPath }, null, 2));
      return 0;
    }

    if (command === 'job') {
      const jobId = positionals[1]?.trim();
      if (!jobId) {
        throw new Error('Indica el identificador del trabajo: job <jobId> [--wait] [--proof-out <ruta.png>].');
      }
      const wait = getBoolFlag(flags, 'wait');
      const proofOut = getStringFlag(flags, 'proof-out');
      const job = wait
        ? await client.waitForJob(jobId, waitOptions)
        : await client.getJob(jobId);

      let proofSavedTo: string | null = null;
      if (proofOut && job.proofUrl) {
        proofSavedTo = await saveProofPng(client, jobId, proofOut);
      }

      stdout(JSON.stringify({ ...job, ...(proofSavedTo ? { proofSavedTo } : {}) }, null, 2));
      return 0;
    }

    if (command === 'notes') {
      const subcommand = positionals[1];
      if (subcommand === 'list') {
        const notes = await client.listNotes();
        stdout(JSON.stringify(notes, null, 2));
        return 0;
      }
      if (subcommand === 'create') {
        const title = getRequiredFlag(flags, 'title');
        const priority = parsePriority(getRequiredFlag(flags, 'priority'));
        const description = getStringFlag(flags, 'description');
        const deadline = getStringFlag(flags, 'deadline');
        const created = await client.createNote({
          title,
          priority,
          description,
          deadline: deadline && deadline.trim() ? deadline.trim() : null,
        });
        stdout(JSON.stringify(created, null, 2));
        return 0;
      }
      throw new Error('Subcomando de notes no reconocido. Usa "notes list" o "notes create".');
    }

    throw new Error(`Comando no reconocido: "${command}". Usa --help para ver los comandos disponibles.`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : 'Error inesperado al ejecutar aula-agent.');
    return 1;
  }
}

if (require.main === module) {
  void runAgentCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
