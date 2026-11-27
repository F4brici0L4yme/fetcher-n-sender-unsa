#!/usr/bin/env node
import { AulaPanelClient, resolveLocalPanelUrl } from './client';
import { AulaMcpServer, AulaMcpServerOptions } from './server';

function parseInternalPort(raw?: string): string {
  const trimmed = raw?.trim() ?? '';
  if (/^\d{1,5}$/.test(trimmed)) {
    const port = Number.parseInt(trimmed, 10);
    if (port >= 1 && port <= 65535) return String(port);
  }
  return '3000';
}

function tryResolvePublicBaseUrl(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return resolveLocalPanelUrl(trimmed);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const sandboxInboxDir = process.env.MCP_INBOX_DIR?.trim() || undefined;
  const explicitPanelUrl = process.env.AULA_PANEL_URL?.trim() || undefined;
  const internalBaseUrl = !explicitPanelUrl && sandboxInboxDir
    ? `http://127.0.0.1:${parseInternalPort(process.env.PORT)}`
    : undefined;

  const client = new AulaPanelClient(internalBaseUrl ? { baseUrl: internalBaseUrl } : undefined);
  const serverOptions: AulaMcpServerOptions = sandboxInboxDir
    ? {
      sandboxInboxDir,
      publicBaseUrl: tryResolvePublicBaseUrl(process.env.APP_PUBLIC_URL),
    }
    : {};

  const server = new AulaMcpServer(client, serverOptions);
  await server.serveStdio(process.stdin, process.stdout);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Error fatal en servidor MCP.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
