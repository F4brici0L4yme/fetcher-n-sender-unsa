import readline from 'node:readline';
import {
  LocalPdfMatchCandidate,
  TaskMatchCandidate,
} from '../../core/domain/command-matcher';
import { TaskView } from '../../core/domain/model';
import { NotePriority } from '../../core/domain/personal-note';
import {
  AgentDeliverResponse,
  AgentJobStatusResponse,
  AgentNoteItem,
  AgentStatusResponse,
  AgentTasksResponse,
  AulaPanelClient,
  findLocalPdfs,
  FindLocalPdfsResult,
  HostPdfFile,
  parseBase64Pdf,
  resolveDeliveryPdfTarget,
  resolveLocalPanelUrl,
  WaitForJobOptions,
} from './client';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {
  name: 'aula-virtual-unsa',
  version: '1.0.0',
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: JsonRpcErrorObject };

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' };

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface AulaMcpServerOptions {
  waitOptions?: WaitForJobOptions;
  sandboxInboxDir?: string;
  publicBaseUrl?: string;
}

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: 'aula_status',
    description:
      'Consulta el estado actual de la sesión local de Aula Virtual UNSA, la política de entrega del agente (confirm_in_panel o direct_on_exact_match), la sincronización automática y los contadores de tareas y notas.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'aula_list_tasks',
    description:
      'Lista las tareas sincronizadas de la cuenta activa en Aula Virtual UNSA. Opcionalmente acepta una consulta (query) en lenguaje natural o siglas de curso (por ejemplo "tarea 3 de mn") para ver coincidencias ordenadas.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta opcional para identificar tareas candidatas (por ejemplo "tarea 3 de mn").',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'aula_sync_tasks',
    description:
      'Solicita una sincronización inmediata de tareas con Aula Virtual UNSA usando la sesión persistente local. Por defecto espera hasta que finalice la búsqueda.',
    inputSchema: {
      type: 'object',
      properties: {
        wait: {
          type: 'boolean',
          description: 'Si es true (por defecto), espera a que termine la sincronización y devuelve el resumen.',
          default: true,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'aula_find_local_pdfs',
    description:
      'Busca archivos PDF válidos dentro del inbox sandbox configurado (por defecto ".") o de una carpeta indicada. Soporta resolución sin distinguir mayúsculas/minúsculas y omite enlaces simbólicos y carpetas ocultas. Si recibe query, clasifica coincidencias como exact, ambiguous o none.',
    inputSchema: {
      type: 'object',
      properties: {
        searchDir: {
          type: 'string',
          description: 'Subcarpeta relativa dentro del inbox sandbox (por ejemplo "." o "mn") o directorio local fuera de sandbox. Opcional en modo sandbox (usa "." por defecto).',
        },
        query: {
          type: 'string',
          description: 'Consulta opcional en lenguaje natural o nombre de archivo (por ejemplo "laboratorio 8 de mn" o "Lab08.pdf").',
        },
        maxDepth: {
          type: 'integer',
          minimum: 0,
          maximum: 8,
          default: 4,
          description: 'Profundidad máxima de subcarpetas a explorar (por defecto 4).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Número máximo de archivos o candidatos devueltos (por defecto 20).',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'aula_deliver_pdf',
    description:
      'Entrega un archivo PDF a una tarea de Aula Virtual UNSA aceptando el PDF en Base64 (pdfBase64 + fileName, sin depender de rutas ni volúmenes locales) O una ruta filePath (archivo o subcarpeta como "mn/Lab08.pdf" o ".", confinada al inbox sandbox cuando está activo). Valida el PDF (cabecera %PDF- y %%EOF, sin seguir enlaces simbólicos) y respeta confirm_in_panel o direct_on_exact_match con comprobante PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Ruta de un archivo PDF (por ejemplo "mn/Lab08.pdf") o de una subcarpeta donde buscarlo (por ejemplo "." o "mn"). No debe combinarse con pdfBase64.',
        },
        pdfBase64: {
          type: 'string',
          description: 'Contenido del archivo PDF codificado en Base64 (opcionalmente con prefijo data:application/pdf;base64,). Requiere fileName y no debe combinarse con filePath.',
        },
        fileName: {
          type: 'string',
          description: 'Nombre original del archivo PDF (por ejemplo "Lab08.pdf") cuando se envía mediante pdfBase64.',
        },
        instruction: {
          type: 'string',
          description: 'Instrucción en lenguaje natural del estudiante (por ejemplo "sube el laboratorio 8 de mn a la tarea correspondiente").',
        },
        taskId: {
          type: 'string',
          description: 'UUID exacto de la tarea destino cuando ya se desambiguó previamente.',
        },
        source: {
          type: 'string',
          description: 'Identificador opcional del cliente o asistente llamante. Por defecto "ai-mcp".',
        },
        waitForResult: {
          type: 'boolean',
          description: 'Si es true (por defecto) y la entrega se autoriza directamente, espera al resultado final e incluye la captura PNG de comprobante.',
          default: true,
        },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'aula_check_job',
    description:
      'Consulta el estado actual de un trabajo de sincronización o entrega por su jobId e incluye la captura PNG de comprobante si está disponible.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Identificador del trabajo devuelto por aula_sync_tasks o aula_deliver_pdf.',
        },
        includeScreenshot: {
          type: 'boolean',
          description: 'Si es true (por defecto), adjunta la imagen image/png del comprobante cuando exista.',
          default: true,
        },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'aula_discard_delivery',
    description:
      'Descarta un intento de entrega fallido o pendiente de verificación (failed o needs_verification) para una tarea, limpiando su registro y permitiendo reintentar la entrega limpiamente con aula_deliver_pdf.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'UUID de la tarea asociada al intento de entrega.',
        },
        jobId: {
          type: 'string',
          description: 'UUID del trabajo de entrega fallido o por verificar que se desea descartar.',
        },
      },
      required: ['taskId', 'jobId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'aula_list_notes',
    description: 'Lista las notas personales de la cuenta activa en el panel local.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'aula_create_note',
    description: 'Crea una nota personal en el panel local para la cuenta activa (visible en tiempo real en la agenda).',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Título de la nota (1 a 200 caracteres).',
        },
        description: {
          type: 'string',
          description: 'Descripción opcional de la nota.',
        },
        priority: {
          type: 'string',
          enum: ['alta', 'media', 'baja'],
          description: 'Prioridad de la nota: alta, media o baja.',
        },
        deadline: {
          type: 'string',
          description: 'Fecha opcional en formato YYYY-MM-DD o ISO con zona horaria.',
        },
      },
      required: ['title', 'priority'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`El parámetro "${key}" debe ser una cadena de texto.`);
  }
  return value;
}

function asRequiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`El parámetro obligatorio "${key}" debe ser un texto no vacío.`);
  }
  return value.trim();
}

function asOptionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`El parámetro "${key}" debe ser booleano (true o false).`);
  }
  return value;
}

function asOptionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`El parámetro "${key}" debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

function normalizeAgentSource(raw?: string): string {
  const clean = (raw ?? '').trim().slice(0, 64);
  return clean || 'ai-mcp';
}

function asPriority(args: Record<string, unknown>): NotePriority {
  const value = args.priority;
  if (value === 'alta' || value === 'media' || value === 'baja') {
    return value;
  }
  throw new Error('El parámetro "priority" debe ser "alta", "media" o "baja".');
}

function formatStatusText(status: AgentStatusResponse): string {
  const sessionText = status.session
    ? `${status.session.state} (${status.session.busy ? 'ocupada' : 'libre'}) — ${status.session.message}`
    : 'Sin sesión activa';
  const syncText = status.autoSync.enabled
    ? `activa cada ${status.autoSync.intervalSeconds} s (última: ${status.autoSync.lastSyncAt ?? 'nunca'}, próxima: ${status.autoSync.nextSyncAt ?? 'pendiente'})`
    : 'desactivada';

  return [
    `Cuenta activa: ${status.accountId}`,
    `Sesión: ${sessionText}`,
    `Política del agente: ${status.policy}`,
    `Auto-sincronización: ${syncText}`,
    `Pendientes: ${status.counts.pendingTasks} tareas, ${status.counts.pendingProposals} propuestas, ${status.counts.pendingNotes} notas (${status.counts.completedTasks} tareas completadas).`,
  ].join('\n');
}

function formatTaskLine(task: TaskView): string {
  const deliveryState = task.delivery ? task.delivery.state : 'sin entrega';
  const deadline = task.deadline ?? 'sin plazo';
  return `- [${task.taskId}] ${task.course} — ${task.title} | plazo: ${deadline} | destino: ${task.destination} | entrega: ${deliveryState}`;
}

function formatCandidates(candidates: readonly TaskMatchCandidate[]): string {
  return candidates
    .map((candidate, index) => {
      const reasons = candidate.reasons.length > 0 ? ` (${candidate.reasons.join(', ')})` : '';
      return `${index + 1}. [${candidate.task.taskId}] ${candidate.task.course} — ${candidate.task.title} | puntaje: ${candidate.score}${reasons}`;
    })
    .join('\n');
}

function formatTasksText(response: AgentTasksResponse): string {
  const lines: string[] = [`Tareas sincronizadas (${response.tasks.length}) para ${response.accountId}:`];
  if (response.tasks.length === 0) {
    lines.push('No hay tareas registradas todavía. Usa aula_sync_tasks para sincronizar.');
  } else {
    for (const task of response.tasks) {
      lines.push(formatTaskLine(task));
    }
  }
  if (response.match) {
    lines.push('');
    lines.push(`Coincidencia para la consulta (${response.match.kind}):`);
    if (response.match.candidates.length > 0) {
      lines.push(formatCandidates(response.match.candidates));
    } else {
      lines.push('Sin candidatas coincidentes.');
    }
  }
  return lines.join('\n');
}

function formatJobText(job: AgentJobStatusResponse, hasProofImage: boolean): string {
  const lines = [
    `Trabajo ${job.jobId} (${job.kind})`,
    `Estado: ${job.state} — ${job.label}${job.active ? ' (en curso)' : ''}`,
  ];
  if (job.summary) lines.push(`Resumen: ${job.summary}`);
  if (job.evidence) {
    lines.push(`Estado visible en Moodle: ${job.evidence.visibleStatus}`);
    if (job.evidence.fileName) lines.push(`Archivo enviado: ${job.evidence.fileName}`);
    if (job.evidence.capturedAt) lines.push(`Captura tomada: ${job.evidence.capturedAt}`);
  }
  if (hasProofImage) {
    lines.push('Comprobante visual PNG adjunto en esta respuesta.');
  }
  return lines.join('\n');
}

function formatPdfCandidates(candidates: readonly LocalPdfMatchCandidate[]): string {
  return candidates
    .map((candidate, index) => {
      const reasons = candidate.reasons.length > 0 ? ` (${candidate.reasons.join(', ')})` : '';
      return `${index + 1}. ${candidate.file.path} [${candidate.file.relativePath}, ${candidate.file.sizeBytes} bytes] | puntaje: ${candidate.score}${reasons}`;
    })
    .join('\n');
}

function formatFoundPdfsText(result: FindLocalPdfsResult, query?: string): string {
  const lines = [
    `Directorio analizado: ${result.resolvedDir} (${result.totalScanned} entradas revisadas)`,
  ];
  const cleanQuery = query?.trim();
  if (cleanQuery) {
    lines.push(`Consulta: "${cleanQuery}" -> resultado: ${result.matchResult.kind}`);
    if (result.matchResult.kind === 'exact' && result.matchResult.match) {
      lines.push(`PDF exacto encontrado: ${result.matchResult.match.file.path}`);
    }
    if (result.matchResult.candidates.length > 0) {
      lines.push('Candidatos ordenados:');
      lines.push(formatPdfCandidates(result.matchResult.candidates));
    } else {
      lines.push('No se encontraron archivos PDF coincidentes con la consulta.');
    }
    return lines.join('\n');
  }

  if (result.files.length === 0) {
    lines.push('No se encontraron archivos PDF válidos en el directorio.');
    return lines.join('\n');
  }

  lines.push(`Archivos PDF encontrados (${result.files.length}):`);
  for (const file of result.files) {
    lines.push(`- ${file.path} [${file.relativePath}, ${file.sizeBytes} bytes, modificado: ${file.modifiedAt}]`);
  }
  return lines.join('\n');
}

function formatNotesText(accountId: string, notes: readonly AgentNoteItem[]): string {
  if (notes.length === 0) {
    return `No hay notas personales registradas para ${accountId}.`;
  }
  const lines = [`Notas personales (${notes.length}) para ${accountId}:`];
  for (const note of notes) {
    const deadline = note.deadline ?? 'sin fecha';
    lines.push(`- [${note.noteId}] (${note.priority}, ${note.status}) ${note.title} | plazo: ${deadline}`);
  }
  return lines.join('\n');
}

function writeLine(stdout: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stdout.off('error', onError);
      stdout.off('drain', onDrain);
    };
    stdout.on('error', onError);
    const ok = stdout.write(line, 'utf8');
    if (ok) {
      cleanup();
      resolve();
    } else {
      stdout.once('drain', onDrain);
    }
  });
}

export class AulaMcpServer {
  private readonly waitOptions: WaitForJobOptions;
  private readonly sandboxInboxDir?: string;
  private readonly publicBaseUrl?: string;

  constructor(
    private readonly client: AulaPanelClient,
    options: AulaMcpServerOptions = {},
  ) {
    this.waitOptions = options.waitOptions ?? {};
    this.sandboxInboxDir = options.sandboxInboxDir?.trim() || undefined;
    const rawPublic = options.publicBaseUrl?.trim();
    this.publicBaseUrl = rawPublic ? resolveLocalPanelUrl(rawPublic) : undefined;
  }

  async handleMessage(raw: unknown): Promise<JsonRpcResponse | null> {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON.' },
        };
      }
    }

    if (!isRecord(parsed)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC 2.0 object.' },
      };
    }

    const rawId = parsed.id;
    const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id') && rawId !== undefined;
    const id: JsonRpcId = typeof rawId === 'string' || typeof rawId === 'number' || rawId === null ? rawId : null;

    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string' || !parsed.method.trim()) {
      if (!hasId) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request: missing jsonrpc "2.0" or method.' },
      };
    }

    const method = parsed.method;
    const params = isRecord(parsed.params) ? parsed.params : {};

    // Notifications must not emit a response per JSON-RPC 2.0 and MCP spec.
    if (!hasId || method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return null;
    }

    try {
      if (method === 'initialize') {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions:
              'Usa estas herramientas para consultar la sesión de Aula Virtual UNSA, listar o sincronizar tareas, localizar archivos PDF en el inbox (aula_find_local_pdfs), entregar PDFs mediante Base64 o ruta (aula_deliver_pdf) con comprobante PNG, descartar intentos fallidos o por verificar (aula_discard_delivery) y gestionar notas personales.',
          },
        };
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
      }

      if (method === 'tools/call') {
        const toolName = typeof params.name === 'string' ? params.name : '';
        if (!toolName || !TOOL_DEFINITIONS.some((t) => t.name === toolName)) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown tool: ${toolName || '(empty)'}` },
          };
        }
        const toolArgs = params.arguments === undefined
          ? {}
          : isRecord(params.arguments)
            ? params.arguments
            : null;
        if (!toolArgs) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: tool arguments must be a JSON object.' },
          };
        }
        const result = await this.executeTool(toolName, toolArgs);
        return { jsonrpc: '2.0', id, result };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal server error.',
        },
      };
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    try {
      switch (name) {
        case 'aula_status':
          return await this.handleStatus();
        case 'aula_list_tasks':
          return await this.handleListTasks(args);
        case 'aula_sync_tasks':
          return await this.handleSyncTasks(args);
        case 'aula_find_local_pdfs':
          return await this.handleFindLocalPdfs(args);
        case 'aula_deliver_pdf':
          return await this.handleDeliverPdf(args);
        case 'aula_check_job':
          return await this.handleCheckJob(args);
        case 'aula_discard_delivery':
          return await this.handleDiscardDelivery(args);
        case 'aula_list_notes':
          return await this.handleListNotes();
        case 'aula_create_note':
          return await this.handleCreateNote(args);
        default:
          return {
            isError: true,
            content: [{ type: 'text', text: `Herramienta desconocida: ${name}` }],
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error inesperado al ejecutar la herramienta.';
      return {
        isError: true,
        content: [{ type: 'text', text: `Error en ${name}: ${message}` }],
      };
    }
  }

  private async handleStatus(): Promise<McpToolCallResult> {
    const status = await this.client.getStatus();
    return {
      content: [{ type: 'text', text: formatStatusText(status) }],
      structuredContent: status as unknown as Record<string, unknown>,
    };
  }

  private async handleListTasks(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const query = asOptionalString(args, 'query');
    const tasks = await this.client.listTasks(query);
    return {
      content: [{ type: 'text', text: formatTasksText(tasks) }],
      structuredContent: tasks as unknown as Record<string, unknown>,
    };
  }

  private async handleSyncTasks(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const wait = asOptionalBoolean(args, 'wait', true);
    const { jobId } = await this.client.triggerSync();
    if (!wait) {
      return {
        content: [{
          type: 'text',
          text: `Sincronización iniciada (jobId: ${jobId}). Usa aula_check_job para consultar el avance.`,
        }],
        structuredContent: { jobId, waited: false },
      };
    }
    const job = await this.client.waitForJob(jobId, this.waitOptions);
    return {
      content: [{ type: 'text', text: formatJobText(job, false) }],
      structuredContent: { jobId, waited: true, job },
    };
  }

  private async handleFindLocalPdfs(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const rawSearchDir = asOptionalString(args, 'searchDir');
    const trimmedSearchDir = rawSearchDir?.trim() ?? '';
    let searchDir: string;
    if (this.sandboxInboxDir) {
      searchDir = trimmedSearchDir || '.';
    } else {
      if (!trimmedSearchDir) {
        throw new Error('El parámetro obligatorio "searchDir" debe ser un texto no vacío.');
      }
      searchDir = trimmedSearchDir;
    }

    const query = asOptionalString(args, 'query');
    const maxDepth = asOptionalInteger(args, 'maxDepth', 0, 8);
    const limit = asOptionalInteger(args, 'limit', 1, 100);

    const result = await findLocalPdfs(searchDir, query, {
      maxDepth,
      limit,
      ...(this.sandboxInboxDir ? { sandboxRoot: this.sandboxInboxDir } : {}),
    });
    return {
      content: [{ type: 'text', text: formatFoundPdfsText(result, query) }],
      structuredContent: {
        resolvedDir: result.resolvedDir,
        totalScanned: result.totalScanned,
        query: query?.trim() || null,
        kind: result.matchResult.kind,
        match: result.matchResult.match,
        candidates: result.matchResult.candidates,
        files: result.files,
        matchResult: result.matchResult,
      },
    };
  }

  private async handleDeliverPdf(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const rawFilePath = asOptionalString(args, 'filePath');
    const rawPdfBase64 = asOptionalString(args, 'pdfBase64');
    const rawFileName = asOptionalString(args, 'fileName');
    const filePath = rawFilePath?.trim() || undefined;
    const pdfBase64 = rawPdfBase64?.trim() || undefined;
    const fileName = rawFileName?.trim() || undefined;

    const instruction = asRequiredString(args, 'instruction');
    const taskId = asOptionalString(args, 'taskId');
    const source = normalizeAgentSource(asOptionalString(args, 'source'));
    const waitForResult = asOptionalBoolean(args, 'waitForResult', true);

    if (filePath && (pdfBase64 || fileName)) {
      throw new Error(
        'Indica únicamente "filePath" o bien "pdfBase64" junto con "fileName", pero no ambos en la misma solicitud.',
      );
    }
    if (!filePath && !pdfBase64) {
      if (fileName) {
        throw new Error(
          'Falta el parámetro "pdfBase64" para acompañar a "fileName", o bien indica "filePath".',
        );
      }
      throw new Error(
        'Debes proporcionar "filePath" (ruta de un PDF o carpeta) o bien "pdfBase64" junto con "fileName".',
      );
    }
    if (pdfBase64 && !fileName) {
      throw new Error(
        'Cuando envías "pdfBase64" debes incluir también "fileName" con el nombre del archivo (por ejemplo "Lab08.pdf").',
      );
    }

    let pdf: HostPdfFile;
    if (pdfBase64 && rawFileName !== undefined) {
      pdf = parseBase64Pdf(rawPdfBase64!, rawFileName);
    } else {
      const resolvedTarget = await resolveDeliveryPdfTarget(
        filePath!,
        instruction,
        this.sandboxInboxDir ? { sandboxRoot: this.sandboxInboxDir } : undefined,
      );
      if (resolvedTarget.kind === 'no_file_match') {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: [
              `No se encontró ningún archivo PDF que coincida con la instrucción dentro de "${resolvedTarget.resolvedDir}" (${resolvedTarget.totalScanned} entradas revisadas).`,
              'Ejecuta aula_find_local_pdfs sin filtro o pide al estudiante la ruta exacta del archivo PDF.',
            ].join('\n'),
          }],
          structuredContent: {
            outcome: 'no_file_match',
            resolvedDir: resolvedTarget.resolvedDir,
            totalScanned: resolvedTarget.totalScanned,
            files: resolvedTarget.files,
          },
        };
      }

      if (resolvedTarget.kind === 'ambiguous_file') {
        return {
          content: [{
            type: 'text',
            text: [
              `Se encontraron varios archivos PDF candidatos dentro de "${resolvedTarget.resolvedDir}". No se realizó ninguna entrega para evitar subir el archivo incorrecto.`,
              'Confirma con el estudiante cuál archivo PDF desea subir y vuelve a invocar aula_deliver_pdf con la ruta exacta:',
              formatPdfCandidates(resolvedTarget.candidates),
            ].join('\n'),
          }],
          structuredContent: {
            outcome: 'ambiguous_file',
            resolvedDir: resolvedTarget.resolvedDir,
            totalScanned: resolvedTarget.totalScanned,
            candidates: resolvedTarget.candidates,
          },
        };
      }

      pdf = resolvedTarget.pdf;
    }

    const delivered = await this.client.deliverPdf({
      pdf,
      instruction,
      taskId,
      source,
      executeIfAllowed: true,
    });

    return this.formatDeliverOutcome(delivered, pdf.originalName, waitForResult, pdf.resolvedPath);
  }

  private resolvePanelUrl(rawPanelUrl?: string): string {
    const externalBase = this.publicBaseUrl ?? this.client.baseUrl;
    if (!rawPanelUrl) {
      return `${externalBase}/agente`;
    }
    const resolved = new URL(rawPanelUrl, `${externalBase}/`);
    if (this.publicBaseUrl) {
      const internalOrigin = new URL(this.client.baseUrl).origin;
      if (resolved.origin === internalOrigin) {
        return new URL(`${resolved.pathname}${resolved.search}${resolved.hash}`, `${this.publicBaseUrl}/`).href;
      }
    }
    return resolved.href;
  }

  private async formatDeliverOutcome(
    delivered: AgentDeliverResponse,
    originalName: string,
    waitForResult: boolean,
    resolvedFilePath?: string,
  ): Promise<McpToolCallResult> {
    const agentPanelUrl = this.resolvePanelUrl(delivered.panelUrl);

    if (delivered.outcome === 'pending_confirmation') {
      const taskDesc = delivered.task
        ? `${delivered.task.course} — ${delivered.task.title} [${delivered.task.taskId}]`
        : 'la tarea seleccionada';
      const proposalId = delivered.proposal?.proposalId ?? '(sin ID)';
      const text = [
        `Propuesta lista para confirmación del estudiante (${proposalId}).`,
        `Archivo validado: ${delivered.pdf?.originalName ?? originalName}`,
        `Tarea destino: ${taskDesc}`,
        `Política activa: ${delivered.policy}`,
        `Abre ${agentPanelUrl} para confirmar y enviar con un clic.`,
        `Si deseas que futuras coincidencias exactas se envíen directamente sin paso previo, cambia la política a "direct_on_exact_match" en ${agentPanelUrl}.`,
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          outcome: 'pending_confirmation',
          policy: delivered.policy,
          proposal: delivered.proposal,
          task: delivered.task,
          pdf: delivered.pdf,
          panelUrl: agentPanelUrl,
          ...(resolvedFilePath ? { resolvedFilePath } : {}),
        },
      };
    }

    if (delivered.outcome === 'ambiguous') {
      const candidates = delivered.candidates ?? [];
      const text = [
        'La instrucción coincide con varias tareas pendientes. No se realizó ninguna entrega para evitar errores.',
        'Pregunta al estudiante cuál tarea elegir y vuelve a invocar aula_deliver_pdf con el "taskId" exacto:',
        formatCandidates(candidates),
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          outcome: 'ambiguous',
          policy: delivered.policy,
          pdfHint: delivered.pdfHint ?? null,
          candidates,
        },
      };
    }

    if (delivered.outcome === 'no_match') {
      const candidates = delivered.candidates ?? [];
      const text = [
        'No se encontró ninguna tarea pendiente de Aula Virtual que coincida con la instrucción.',
        'Ejecuta aula_list_tasks o aula_sync_tasks para verificar las tareas disponibles y pide confirmación al estudiante.',
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          outcome: 'no_match',
          policy: delivered.policy,
          pdfHint: delivered.pdfHint ?? null,
          candidates,
        },
      };
    }

    // outcome === 'authorized'
    const jobId = delivered.jobId;
    if (!waitForResult || !jobId) {
      return {
        content: [{
          type: 'text',
          text: [
            `Entrega autorizada directamente (jobId: ${jobId ?? 'desconocido'}).`,
            `Archivo: ${delivered.pdf?.originalName ?? originalName}`,
            `Tarea: ${delivered.task ? `${delivered.task.course} — ${delivered.task.title}` : 'asignada'}`,
            'Usa aula_check_job para consultar el resultado y la captura del comprobante.',
          ].join('\n'),
        }],
        structuredContent: {
          outcome: 'authorized',
          policy: delivered.policy,
          jobId,
          proposal: delivered.proposal,
          task: delivered.task,
          pdf: delivered.pdf,
          waited: false,
        },
      };
    }

    const job = await this.client.waitForJob(jobId, this.waitOptions);
    let png: Buffer | null = null;
    let proofWarning: string | null = null;
    if (job.proofUrl) {
      try {
        png = await this.client.fetchProofPng(jobId);
      } catch (error) {
        proofWarning = error instanceof Error ? error.message : 'No se pudo descargar la captura PNG.';
      }
    }
    const summaryLines = [
      `Entrega ejecutada para ${delivered.task ? `${delivered.task.course} — ${delivered.task.title}` : 'la tarea seleccionada'}.`,
      `Archivo: ${delivered.pdf?.originalName ?? originalName} (SHA-256: ${delivered.pdf?.sha256 ?? 'verificado'})`,
      formatJobText(job, Boolean(png)),
    ];
    if (job.state === 'confirmed') {
      summaryLines.push('La tarea queda marcada como completada en el panel.');
    }
    if (proofWarning) {
      summaryLines.push(`Aviso sobre captura: ${proofWarning} Puedes reintentar con aula_check_job.`);
    }

    const content: McpContentBlock[] = [{ type: 'text', text: summaryLines.join('\n') }];
    if (png) {
      content.push({
        type: 'image',
        data: png.toString('base64'),
        mimeType: 'image/png',
      });
    }

    return {
      content,
      structuredContent: {
        outcome: 'authorized',
        policy: delivered.policy,
        jobId,
        proposal: delivered.proposal,
        task: delivered.task,
        pdf: delivered.pdf,
        job,
        hasProofImage: Boolean(png),
        ...(resolvedFilePath ? { resolvedFilePath } : {}),
        ...(proofWarning ? { proofWarning } : {}),
      },
    };
  }

  private async handleCheckJob(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const jobId = asRequiredString(args, 'jobId');
    const includeScreenshot = asOptionalBoolean(args, 'includeScreenshot', true);

    const job = await this.client.getJob(jobId);
    let png: Buffer | null = null;
    let proofWarning: string | null = null;
    if (includeScreenshot && job.proofUrl) {
      try {
        png = await this.client.fetchProofPng(jobId);
      } catch (error) {
        proofWarning = error instanceof Error ? error.message : 'No se pudo descargar la captura PNG.';
      }
    }

    const text = proofWarning
      ? `${formatJobText(job, false)}\nAviso sobre captura: ${proofWarning}`
      : formatJobText(job, Boolean(png));
    const content: McpContentBlock[] = [{ type: 'text', text }];
    if (png) {
      content.push({
        type: 'image',
        data: png.toString('base64'),
        mimeType: 'image/png',
      });
    }

    return {
      content,
      structuredContent: {
        job,
        hasProofImage: Boolean(png),
        ...(proofWarning ? { proofWarning } : {}),
      },
    };
  }

  private async handleDiscardDelivery(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const taskId = asRequiredString(args, 'taskId');
    const jobId = asRequiredString(args, 'jobId');
    const result = await this.client.discardDelivery(taskId, jobId);
    return {
      content: [{
        type: 'text',
        text: `Intento de entrega ${result.jobId} descartado para la tarea ${taskId}. Ya puedes reintentar el envío limpiamente con aula_deliver_pdf.`,
      }],
      structuredContent: {
        taskId,
        jobId: result.jobId,
        discarded: true,
      },
    };
  }

  private async handleListNotes(): Promise<McpToolCallResult> {
    const response = await this.client.listNotes();
    return {
      content: [{ type: 'text', text: formatNotesText(response.accountId, response.notes) }],
      structuredContent: response as unknown as Record<string, unknown>,
    };
  }

  private async handleCreateNote(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const title = asRequiredString(args, 'title');
    const priority = asPriority(args);
    const description = asOptionalString(args, 'description');
    const deadline = asOptionalString(args, 'deadline');

    const created = await this.client.createNote({
      title,
      priority,
      description,
      deadline: deadline && deadline.trim() ? deadline.trim() : null,
    });

    return {
      content: [{
        type: 'text',
        text: `Nota creada [${created.note.noteId}]: "${created.note.title}" (prioridad: ${created.note.priority}, plazo: ${created.note.deadline ?? 'sin fecha'}).`,
      }],
      structuredContent: created as unknown as Record<string, unknown>,
    };
  }

  async serveStdio(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Promise<void> {
    const rl = readline.createInterface({
      input: stdin,
      crlfDelay: Infinity,
    });

    try {
      for await (const rawLine of rl) {
        if (!rawLine.trim()) continue;
        const reply = await this.handleMessage(rawLine);
        if (reply !== null) {
          await writeLine(stdout, `${JSON.stringify(reply)}\n`);
        }
      }
    } finally {
      rl.close();
    }
  }
}

export function serveStdio(
  server: AulaMcpServer,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  return server.serveStdio(stdin, stdout);
}
