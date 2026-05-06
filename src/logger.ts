export interface SlothLogger {
  info(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
  debug(msg: string, ...meta: unknown[]): void;
  /**
   * Optional. Loggers that don't support contextual children (`console`,
   * `@nestjs/common` Logger, electron-log, etc.) can omit this. The package
   * never relies on `child()` internally — `withLogLevel` only proxies it
   * when the wrapped logger has it.
   */
  child?(meta: Record<string, unknown>): SlothLogger;
}

export type SlothLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const rankFor = (level: SlothLogLevel): number => {
  switch (level) {
    case 'debug':
      return 10;
    case 'info':
      return 20;
    case 'warn':
      return 30;
    case 'error':
      return 40;
    case 'silent':
      return 100;
  }
};

export class NoOpLogger implements SlothLogger {
  info(_msg: string, ..._meta: unknown[]): void {}
  warn(_msg: string, ..._meta: unknown[]): void {}
  error(_msg: string, ..._meta: unknown[]): void {}
  debug(_msg: string, ..._meta: unknown[]): void {}
  child(_meta: Record<string, unknown>): SlothLogger {
    return this;
  }
}

// Returns the inner logger wrapped with `withLogLevel` if a level is given, otherwise unchanged.
// Centralizes the conditional so callsites never widen the type to `unknown`.
export const resolveLogger = (inner: SlothLogger, minLevel?: SlothLogLevel): SlothLogger =>
  minLevel ? withLogLevel(inner, minLevel) : inner;

// Wraps an existing SlothLogger and drops calls below `minLevel`. Use to suppress
// noisy `debug`/`info` from this library while keeping the consumer's logger intact.
export const withLogLevel = (inner: SlothLogger, minLevel: SlothLogLevel): SlothLogger => {
  const min = rankFor(minLevel);
  const allow = (level: Exclude<SlothLogLevel, 'silent'>): boolean => rankFor(level) >= min;
  const base: SlothLogger = {
    debug: (msg, ...meta) => {
      if (allow('debug')) inner.debug(msg, ...meta);
    },
    info: (msg, ...meta) => {
      if (allow('info')) inner.info(msg, ...meta);
    },
    warn: (msg, ...meta) => {
      if (allow('warn')) inner.warn(msg, ...meta);
    },
    error: (msg, ...meta) => {
      if (allow('error')) inner.error(msg, ...meta);
    },
  };
  // Only expose `child` on the wrapper when the inner logger has it. Avoids
  // synthesising a no-op child that would silently drop context metadata.
  // `.bind(inner)` keeps `this` attached for winston/pino-style loggers whose
  // `child` implementations depend on it.
  const childFn = inner.child?.bind(inner);
  if (childFn) base.child = (meta) => withLogLevel(childFn(meta), minLevel);
  return base;
};

/**
 * Minimal `SlothLogger` that delegates to the global `console`. Suitable for
 * scripts, demos, and quick local debugging. Production code should use a
 * structured logger (winston, pino, bunyan) instead.
 *
 * Has no `child()` — contextual logging belongs in a real structured logger.
 */
export const consoleLogger: SlothLogger = {
  info: (msg, ...meta) => {
    console.log(msg, ...meta);
  },
  warn: (msg, ...meta) => {
    console.warn(msg, ...meta);
  },
  error: (msg, ...meta) => {
    console.error(msg, ...meta);
  },
  debug: (msg, ...meta) => {
    console.debug(msg, ...meta);
  },
};
