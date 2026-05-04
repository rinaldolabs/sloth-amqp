import { describe, expect, it } from 'vitest';
import { NoOpLogger } from '../logger.js';

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
