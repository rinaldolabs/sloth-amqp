export interface SlothLogger {
  info(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
  debug(msg: string, ...meta: unknown[]): void;
  child(meta: Record<string, unknown>): SlothLogger;
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

// Wraps an existing SlothLogger and drops calls below `minLevel`. Use to suppress
// noisy `debug`/`info` from this library while keeping the consumer's logger intact.
export const withLogLevel = (inner: SlothLogger, minLevel: SlothLogLevel): SlothLogger => {
  const min = rankFor(minLevel);
  const allow = (level: Exclude<SlothLogLevel, 'silent'>): boolean => rankFor(level) >= min;
  return {
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
    child: (meta) => withLogLevel(inner.child(meta), minLevel),
  };
};
