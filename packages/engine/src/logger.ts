/**
 * Structured one-line JSON logs. Anything that looks like a credential is
 * redacted before it is written — provider errors can echo request URLs, and
 * RPC URLs often carry an API key in the path or query.
 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SECRET_PATTERNS: RegExp[] = [
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, // DB password
  /(\b\d{8,10}:)[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /([?&](?:api[-_]?key|key|token|apikey|access_token)=)[^&\s]+/gi,
  /(\/v[23]\/)[A-Za-z0-9_-]{20,}/g, // Alchemy/Infura-style key-in-path
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '$1[REDACTED]'), text);
}

export function createLogger(component: string, write: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, component, msg, ...fields });
    write(redact(line));
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
