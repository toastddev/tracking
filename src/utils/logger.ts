// Structured JSON logger compatible with Google Cloud Logging.
//
// On Cloud Run, anything written to stdout/stderr that is valid JSON is parsed
// by Cloud Logging. The `severity` field (uppercase) drives the log-explorer
// severity column and the alert-policy filters. The optional `serviceContext`
// block on ERROR/CRITICAL entries flips them into Error Reporting where they
// get grouped by stack trace.
//
// Existing call sites use logger.debug/info/warn/error(msg, meta?). That
// signature is preserved. `critical` is new: use it for events that should
// trigger the email alert channel (job dead, OAuth blown, repeated failure).

type Level = 'debug' | 'info' | 'warn' | 'error' | 'critical';

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

const SEVERITY: Record<Level, Severity> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  critical: 'CRITICAL',
};

const SERVICE = process.env.SERVICE_NAME ?? 'tracking-backend';
const ENVIRONMENT = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const VERSION = process.env.APP_VERSION ?? '';

function flattenError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      'error.name': err.name,
      'error.message': err.message,
      'error.stack': err.stack,
    };
  }
  if (typeof err === 'string') return { 'error.message': err };
  if (err && typeof err === 'object') return { 'error.message': JSON.stringify(err) };
  return { 'error.message': String(err) };
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const severity = SEVERITY[level];
  // Split a meta.error field (if it's an Error/string) into structured fields
  // so Error Reporting can group it. Original key is dropped to avoid the
  // [object Object] stringification that breaks log explorer.
  const { error, ...rest } = meta ?? {};
  const errorFields = error !== undefined ? flattenError(error) : {};

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    severity,
    level, // back-compat with existing log queries
    msg,
    service: SERVICE,
    environment: ENVIRONMENT,
    ...errorFields,
    ...rest,
  };

  // Error Reporting needs a serviceContext block when we want it to pick the
  // entry up. Only attach on ERROR/CRITICAL to keep INFO logs lean.
  if (severity === 'ERROR' || severity === 'CRITICAL') {
    entry.serviceContext = VERSION
      ? { service: SERVICE, version: VERSION }
      : { service: SERVICE };
  }

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'critical') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug:    (msg: string, meta?: Record<string, unknown>) => emit('debug',    msg, meta),
  info:     (msg: string, meta?: Record<string, unknown>) => emit('info',     msg, meta),
  warn:     (msg: string, meta?: Record<string, unknown>) => emit('warn',     msg, meta),
  error:    (msg: string, meta?: Record<string, unknown>) => emit('error',    msg, meta),
  critical: (msg: string, meta?: Record<string, unknown>) => emit('critical', msg, meta),
};
