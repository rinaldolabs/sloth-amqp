import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { consoleLogger, NoOpLogger, withLogLevel, type SlothLogger } from '../logger.js';

const makeMockLogger = (): SlothLogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: SlothLogger): SlothLogger {
    return this;
  }),
});

describe('NoOpLogger', () => {
  const logger = new NoOpLogger();

  it('info does nothing', () => {
    expect(() => logger.info('msg', { extra: true })).not.toThrow();
  });

  it('warn does nothing', () => {
    expect(() => logger.warn('msg')).not.toThrow();
  });

  it('error does nothing', () => {
    expect(() => logger.error('msg', new Error('e'))).not.toThrow();
  });

  it('debug does nothing', () => {
    expect(() => logger.debug('msg')).not.toThrow();
  });

  it('child returns the same instance', () => {
    expect(logger.child({ fn: 'test' })).toBe(logger);
  });
});

describe('withLogLevel', () => {
  it('forwards all levels at debug minimum', () => {
    const inner = makeMockLogger();
    const wrapped = withLogLevel(inner, 'debug');
    wrapped.debug('d');
    wrapped.info('i');
    wrapped.warn('w');
    wrapped.error('e');
    expect(inner.debug).toHaveBeenCalledWith('d');
    expect(inner.info).toHaveBeenCalledWith('i');
    expect(inner.warn).toHaveBeenCalledWith('w');
    expect(inner.error).toHaveBeenCalledWith('e');
  });

  it('drops debug and info at warn minimum', () => {
    const inner = makeMockLogger();
    const wrapped = withLogLevel(inner, 'warn');
    wrapped.debug('d');
    wrapped.info('i');
    wrapped.warn('w');
    wrapped.error('e');
    expect(inner.debug).not.toHaveBeenCalled();
    expect(inner.info).not.toHaveBeenCalled();
    expect(inner.warn).toHaveBeenCalledWith('w');
    expect(inner.error).toHaveBeenCalledWith('e');
  });

  it('only error at error minimum', () => {
    const inner = makeMockLogger();
    const wrapped = withLogLevel(inner, 'error');
    wrapped.warn('w');
    wrapped.error('e');
    expect(inner.warn).not.toHaveBeenCalled();
    expect(inner.error).toHaveBeenCalledWith('e');
  });

  it('silent drops everything', () => {
    const inner = makeMockLogger();
    const wrapped = withLogLevel(inner, 'silent');
    wrapped.debug('d');
    wrapped.info('i');
    wrapped.warn('w');
    wrapped.error('e');
    expect(inner.debug).not.toHaveBeenCalled();
    expect(inner.info).not.toHaveBeenCalled();
    expect(inner.warn).not.toHaveBeenCalled();
    expect(inner.error).not.toHaveBeenCalled();
  });

  it('forwards meta arguments', () => {
    const inner = makeMockLogger();
    const wrapped = withLogLevel(inner, 'debug');
    wrapped.info('msg', { a: 1 }, 'b');
    expect(inner.info).toHaveBeenCalledWith('msg', { a: 1 }, 'b');
  });

  it('child preserves the level filter', () => {
    const inner = makeMockLogger();
    const wrapped = withLogLevel(inner, 'warn');
    // child is optional in the public type; the inner mock provides it,
    // so the wrapper must too.
    expect(wrapped.child).toBeTypeOf('function');
    const child = wrapped.child!({ fn: 'x' });
    child.info('i');
    child.error('e');
    expect(inner.info).not.toHaveBeenCalled();
    expect(inner.error).toHaveBeenCalledWith('e');
  });

  it('omits child on the wrapper when inner has no child', () => {
    const inner: SlothLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const wrapped = withLogLevel(inner, 'debug');
    expect(wrapped.child).toBeUndefined();
    // The four levels still work — child being absent doesn't break the wrapper.
    wrapped.info('hello');
    expect(inner.info).toHaveBeenCalledWith('hello');
  });
});

describe('consoleLogger', () => {
  // Spies are created per-test and restored after each one so the underlying
  // console methods don't stay mocked for the rest of the Vitest worker.
  let logSpy: MockInstance<typeof console.log>;
  let warnSpy: MockInstance<typeof console.warn>;
  let errorSpy: MockInstance<typeof console.error>;
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards info to console.log with meta', () => {
    consoleLogger.info('msg', { a: 1 }, 'b');
    expect(logSpy).toHaveBeenCalledWith('msg', { a: 1 }, 'b');
  });

  it('forwards warn to console.warn', () => {
    consoleLogger.warn('w');
    expect(warnSpy).toHaveBeenCalledWith('w');
  });

  it('forwards error to console.error', () => {
    consoleLogger.error('e', new Error('boom'));
    expect(errorSpy).toHaveBeenCalledWith('e', new Error('boom'));
  });

  it('forwards debug to console.debug', () => {
    consoleLogger.debug('d');
    expect(debugSpy).toHaveBeenCalledWith('d');
  });

  it('has no child method (contextual logging belongs in structured loggers)', () => {
    expect(consoleLogger.child).toBeUndefined();
  });
});
