type RendererLogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

const LOG_LEVELS: RendererLogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];
const SENSITIVE_KEY_RE =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|webhook)/i;

let installed = false;

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]');
}

function serializeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (seen.has(value)) return '[Circular]';
  if (depth >= 4) return '[MaxDepth]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => serializeLogValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : serializeLogValue(item, depth + 1, seen);
  }
  return out;
}

export function setupRendererLogger(): void {
  if (installed) return;
  installed = true;

  const original = Object.fromEntries(
    LOG_LEVELS.map((level) => [level, console[level].bind(console)]),
  ) as Record<RendererLogLevel, (...args: unknown[]) => void>;

  for (const level of LOG_LEVELS) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      window.electronAPI.logRenderer({
        level,
        timestamp: new Date().toISOString(),
        url: window.location.href,
        args: args.map((arg) => serializeLogValue(arg)),
      });
    };
  }

  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled renderer promise rejection:', event.reason);
  });
}
