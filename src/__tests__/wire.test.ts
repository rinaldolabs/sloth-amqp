import { describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';
import { makeWireEmitter } from '../wire.js';
import type { SlothWireOutbound } from '../types.js';

const event: SlothWireOutbound = {
  direction: 'out',
  exchange: 'sloth.direct.exchange.request',
  routingKey: 'delay',
  content: Buffer.from('{}'),
};

const mockLogger: SlothLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('makeWireEmitter', () => {
  it('is a no-op when no hook is provided and never calls the producer', () => {
    const produce = vi.fn(() => event);
    const emit = makeWireEmitter(undefined, mockLogger);
    expect(() => {
      emit(produce);
    }).not.toThrow();
    expect(produce).not.toHaveBeenCalled();
  });

  it('invokes the hook with the produced event', () => {
    const hook = vi.fn();
    makeWireEmitter(hook, mockLogger)(() => event);
    expect(hook).toHaveBeenCalledWith(event);
  });

  it('swallows and logs a throwing hook without propagating', () => {
    vi.clearAllMocks();
    const hook = vi.fn(() => {
      throw new Error('observer boom');
    });
    expect(() => {
      makeWireEmitter(hook, mockLogger)(() => event);
    }).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('observer boom'),
      expect.objectContaining({ event: 'sloth.wire.hook_failed', direction: 'out' }),
    );
  });
});
