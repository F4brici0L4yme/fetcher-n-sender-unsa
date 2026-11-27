import { Body, Controller, Delete, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AulaPanelClient, resolveLocalPanelUrl } from '../../mcp/client';
import { AulaMcpServer, type JsonRpcId } from '../../mcp/server';
import { PanelWriteGuard } from '../panel-write.guard';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_SANDBOX_INBOX_DIR = '/inbox';
const METHOD_NOT_ALLOWED_ERROR = 'Este servidor MCP usa Streamable HTTP stateless sobre POST /mcp.';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryResolveLoopbackOrigin(raw?: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const resolved = resolveLocalPanelUrl(trimmed);
    const parsed = new URL(resolved);
    if (parsed.pathname && parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function resolveInternalBridgeUrl(req: Request): string {
  const socketPort = req.socket?.localPort;
  if (typeof socketPort === 'number' && Number.isInteger(socketPort) && socketPort >= 1 && socketPort <= 65535) {
    return `http://127.0.0.1:${socketPort}`;
  }
  const rawEnvPort = process.env.PORT?.trim() ?? '';
  if (/^\d{1,5}$/.test(rawEnvPort)) {
    const parsed = Number.parseInt(rawEnvPort, 10);
    if (parsed >= 1 && parsed <= 65535) {
      return `http://127.0.0.1:${parsed}`;
    }
  }
  return 'http://127.0.0.1:3000';
}

function resolvePublicBaseUrl(req: Request, internalUrl: string): string {
  const fromEnv = tryResolveLoopbackOrigin(process.env.APP_PUBLIC_URL);
  if (fromEnv) return fromEnv;
  const rawHost = req.get('host')?.trim();
  const fromHost = rawHost ? tryResolveLoopbackOrigin(`http://${rawHost}`) : null;
  if (fromHost) return fromHost;
  return internalUrl;
}

@Controller('mcp')
@UseGuards(PanelWriteGuard)
export class McpHttpController {
  @Post()
  async handlePost(@Req() req: Request, @Body() body: unknown, @Res() res: Response): Promise<void> {
    res.setHeader('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);
    res.setHeader('Cache-Control', 'no-store');

    if (!isJsonObject(body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request: expected a single JSON-RPC 2.0 object.',
        },
      });
      return;
    }

    const rawId = body.id;
    const id: JsonRpcId = typeof rawId === 'string' || typeof rawId === 'number' || rawId === null ? rawId : null;
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || !body.method.trim()) {
      res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message: 'Invalid Request: missing jsonrpc "2.0" or method.',
        },
      });
      return;
    }

    const internalUrl = resolveInternalBridgeUrl(req);
    const publicBaseUrl = resolvePublicBaseUrl(req, internalUrl);
    const sandboxInboxDir = process.env.MCP_INBOX_DIR?.trim() || DEFAULT_SANDBOX_INBOX_DIR;

    const server = new AulaMcpServer(
      new AulaPanelClient({ baseUrl: internalUrl }),
      { sandboxInboxDir, publicBaseUrl },
    );
    const reply = await server.handleMessage(body);

    if (reply === null) {
      res.status(202).end();
      return;
    }

    res.status(200).json(reply);
  }

  @Get()
  handleGet(@Res() res: Response): void {
    this.rejectUnsupportedMethod(res);
  }

  @Delete()
  handleDelete(@Res() res: Response): void {
    this.rejectUnsupportedMethod(res);
  }

  private rejectUnsupportedMethod(res: Response): void {
    res.setHeader('Allow', 'POST');
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: METHOD_NOT_ALLOWED_ERROR });
  }
}
