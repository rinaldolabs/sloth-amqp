import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';

const mockCheckExchange = vi.fn().mockResolvedValue(undefined);
const mockChannelClose = vi.fn().mockResolvedValue(undefined);
let channelErrorHandler: ((err: unknown) => void) | null = null;
const mockChannelOn = vi.fn((event: string, handler: unknown) => {
  if (event === 'error') channelErrorHandler = handler as (err: unknown) => void;
});
const mockChannel = {
  checkExchange: mockCheckExchange,
  close: mockChannelClose,
  on: mockChannelOn,
};
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
    channelErrorHandler = null;
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

  it('wraps a foreign checkExchange failure as SlothConnectError with the cause', async () => {
    const { ping } = await import('../ping.js');
    const { SlothConnectError } = await import('../errors.js');
    const broker = new Error('NOT_FOUND - no exchange');
    mockCheckExchange.mockRejectedValueOnce(broker);
    const rejection = await ping(mockClient as never).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(SlothConnectError);
    if (!(rejection instanceof SlothConnectError)) throw new Error('unreachable');
    expect(rejection.code).toBe('SLOTH_CONNECT');
    expect(rejection.cause).toBe(broker);
  });

  it('wraps a foreign createChannel failure as SlothConnectError', async () => {
    const { ping } = await import('../ping.js');
    const { SlothConnectError } = await import('../errors.js');
    mockCreateChannel.mockRejectedValueOnce(new Error('no channels left'));
    await expect(ping(mockClient as never)).rejects.toBeInstanceOf(SlothConnectError);
  });

  it('attaches an error listener that absorbs the channel error event', async () => {
    const { ping } = await import('../ping.js');
    const mockLoggerLocal: SlothLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    // The broker closes the channel on a failed passive check AND emits
    // 'error' on it — the listener must absorb the event (debug log), or the
    // emit would escape as an uncaught exception.
    mockCheckExchange.mockImplementationOnce(() => {
      channelErrorHandler?.(new Error('channel closed by server'));
      return Promise.reject(new Error('NOT_FOUND - no exchange'));
    });
    await expect(ping(mockClient as never, { logger: mockLoggerLocal })).rejects.toThrow(
      'NOT_FOUND',
    );
    expect(mockChannelOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockLoggerLocal.debug).toHaveBeenCalledWith(
      'sloth: ping channel error',
      expect.objectContaining({
        event: 'sloth.ping.channel_error',
        reason: 'channel closed by server',
      }),
    );
  });

  it('closes the channel if createChannel resolves after abort (no leak)', async () => {
    const { ping } = await import('../ping.js');
    const ac = new AbortController();
    let resolveCreate!: (c: typeof mockChannel) => void;
    mockCreateChannel.mockReturnValueOnce(
      new Promise<typeof mockChannel>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    setTimeout(() => {
      ac.abort(new Error('cancelled'));
    }, 5);
    await expect(ping(mockClient as never, { signal: ac.signal })).rejects.toThrow('cancelled');

    // Loser resolves after the race lost — safeClose must reap it.
    resolveCreate(mockChannel);
    await new Promise((r) => setImmediate(r));
    expect(mockChannelClose).toHaveBeenCalled();
  });

  it('propagates a caller abort reason by identity (never wrapped)', async () => {
    const { ping } = await import('../ping.js');
    const reason = new Error('shutting down');
    const ac = new AbortController();
    mockCheckExchange.mockReturnValueOnce(new Promise(() => {})); // hung
    setTimeout(() => {
      ac.abort(reason);
    }, 5);
    await expect(ping(mockClient as never, { signal: ac.signal })).rejects.toBe(reason);
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
