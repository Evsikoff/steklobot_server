type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, extra?: unknown) {
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  };
  if (extra !== undefined) {
    line.data = extra instanceof Error ? { name: extra.name, message: extra.message, stack: extra.stack } : extra;
  }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg: string, extra?: unknown) => write('debug', msg, extra),
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
