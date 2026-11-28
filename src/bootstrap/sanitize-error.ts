const REDACT_SECRET_PATTERN = /(?:["']?(?:set-)?cookie["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n}]+)|["']?authorization["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|digest\s+[^\r\n;}]+|[a-z0-9._-]+\s+[^\s;,&"'\r\n}]+|[^\s;,&"'\r\n}]+)|\bbearer\s+[^\s;,&"'\r\n}]+|["']?(?:password|passwd|pwd|sesskey|moodlesession[a-z0-9_-]*|api[_-]?key|(?:[a-z0-9]+[_-])?(?:secret|token))["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;,&"'\r\n}\]]+)|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@)/gi;

function sanitizeFragment(raw: string, maxLength: number): string {
  return raw
    .replace(REDACT_SECRET_PATTERN, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeErrorDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) {
    if (typeof error !== 'string') return 'Unknown error';
    return sanitizeFragment(error, 200) || 'Unknown error';
  }
  const name = sanitizeFragment(error.name || 'Error', 64) || 'Error';
  const rawCode = (error as { code?: unknown }).code;
  const cleanCode = typeof rawCode === 'string' || typeof rawCode === 'number'
    ? sanitizeFragment(String(rawCode), 64)
    : '';
  const code = cleanCode ? ` [${cleanCode}]` : '';
  const message = sanitizeFragment(error.message ?? '', 200);
  return message ? `${name}${code}: ${message}` : `${name}${code}`;
}
