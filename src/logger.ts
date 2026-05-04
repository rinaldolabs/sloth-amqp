export interface SlothLogger {
  info(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
  debug(msg: string, ...meta: unknown[]): void;
  child(meta: Record<string, unknown>): SlothLogger;
}

export class NoOpLogger implements SlothLogger {
  info(_msg: string, ..._meta: unknown[]): void {}
  warn(_msg: string, ..._meta: unknown[]): void {}
  error(_msg: string, ..._meta: unknown[]): void {}
  debug(_msg: string, ..._meta: unknown[]): void {}
  child(_meta: Record<string, unknown>): SlothLogger {
    return this;
  }
}
