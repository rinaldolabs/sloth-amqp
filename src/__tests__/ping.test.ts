import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';

const mockCheckExchange = vi.fn().mockResolvedValue(undefined);
const mockChannelClose = vi.fn().mockResolvedValue(undefined);
const mockChannel = { checkExchange: mockCheckExchange, close: mockChannelClose };
const mockCreateChannel = vi.fn().mockResolvedValue(mockChannel);
const mockClient = { createChannel: mockCreateChannel };

const mockLogger: SlothLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

describe('ping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckExchange.mockResolvedValue(undefined);
    mockChannelClose.mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValue(mockChannel);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a channel, calls checkExchange, and closes the channel on success', async () => {
    const { ping } = await import('../ping.js');
    await ping(mockClient as never);

    expect(mockCreateChannel).toHaveBeenCalledTimes(1);
    expect(mockCheckExchange).toHaveBeenCalledWith('sloth.direct.exchange.request');
    expect(mockChannelClose).toHaveBeenCalledTimes(1);
  });

  it('throws when the broker does not have the request exchange', async () => {
    const { ping } = await import('../ping.js');
    mockCheckExchange.mockRejectedValueOnce(new Error('NOT_FOUND - no exchange'));
    await expect(ping(mockClient as never)).rejects.toThrow('NOT_FOUND');
    // Channel still gets closed via finally.
    expect(mockChannelClose).toHaveBeenCalled();
  });

  it('logs a structured event when checkExchange fails', async () => {
    const { ping } = await import('../ping.js');
    mockCheckExchange.mockRejectedValueOnce(new Error('boom'));
    await expect(ping(mockClient as never, { logger: mockLogger })).rejects.toThrow('boom');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'sloth: ping failed',
      expect.objectContaining({ event: 'sloth.ping.failed', reason: 'boom' }),
    );
  });

  it('throws immediately when caller-supplied signal is already aborted', async () => {
    const { ping } = await import('../ping.js');
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    await expect(ping(mockClient as never, { signal: ac.signal })).rejects.toThrow('pre-aborted');
    expect(mockCreateChannel).not.toHaveBeenCalled();
  });

  it('rejects with TimeoutError when timeoutMs elapses', async () => {
    vi.useFakeTimers();
    const { ping } = await import('../ping.js');
    mockCreateChannel.mockReturnValueOnce(new Promise(() => {})); // hung
    const promise = ping(mockClient as never, { timeoutMs: 50 });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(51);
    await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('rejects invalid timeoutMs before any I/O', async () => {
    const { ping } = await import('../ping.js');
    await expect(ping(mockClient as never, { timeoutMs: -1 })).rejects.toThrow(
      'timeoutMs must be a positive finite number',
    );
    expect(mockCreateChannel).not.toHaveBeenCalled();
  });

  it('uses NoOpLogger when no logger is provided', async () => {
    const { ping } = await import('../ping.js');
    mockCheckExchange.mockRejectedValueOnce(new Error('silent-failure'));
    await expect(ping(mockClient as never)).rejects.toThrow('silent-failure');
    // No logger to assert on, but the call must not throw because of missing logger.
  });
});
