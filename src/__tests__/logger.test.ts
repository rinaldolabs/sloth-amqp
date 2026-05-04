import { describe, expect, it, vi } from 'vitest';
import { NoOpLogger, withLogLevel, type SlothLogger } from '../logger.js';

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
    const child = wrapped.child({ fn: 'x' });
    child.info('i');
    child.error('e');
    expect(inner.info).not.toHaveBeenCalled();
    expect(inner.error).toHaveBeenCalledWith('e');
  });
});
