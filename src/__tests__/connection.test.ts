import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockClient = { close: mockClose };
const mockConnect = vi.fn().mockResolvedValue(mockClient);

vi.mock('amqplib', () => ({ default: { connect: mockConnect } }));

describe('slothConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(mockClient);
  });

  it('connects to the given URL', async () => {
    const { slothConnect } = await import('../connection.js');
    await slothConnect('amqp://localhost');
    expect(mockConnect).toHaveBeenCalledWith('amqp://localhost');
  });

  it('throws if URL is empty', async () => {
    const { slothConnect } = await import('../connection.js');
    await expect(slothConnect('')).rejects.toThrow('AMQP URL must not be empty');
  });

  it('runs setup functions after connecting', async () => {
    const { slothConnect } = await import('../connection.js');
    const setup1 = vi.fn().mockResolvedValue(undefined);
    const setup2 = vi.fn().mockResolvedValue(undefined);
    const client = await slothConnect('amqp://localhost', setup1, setup2);
    expect(setup1).toHaveBeenCalledWith(client);
    expect(setup2).toHaveBeenCalledWith(client);
  });

  it('returns the connected client', async () => {
    const { slothConnect } = await import('../connection.js');
    const client = await slothConnect('amqp://localhost');
    expect(client).toBe(mockClient);
  });

  it('propagates connection errors', async () => {
    const { slothConnect } = await import('../connection.js');
    mockConnect.mockRejectedValueOnce(new Error('refused'));
    await expect(slothConnect('amqp://bad')).rejects.toThrow('refused');
  });

  it('throws immediately when caller-supplied signal is already aborted', async () => {
    const { slothConnect } = await import('../connection.js');
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    await expect(
      slothConnect('amqp://localhost', { signal: ac.signal }),
    ).rejects.toThrow('pre-aborted');
    // amqp.connect should never have been called.
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects with TimeoutError when timeoutMs elapses before connect resolves', async () => {
    vi.useFakeTimers();
    try {
      const { slothConnect } = await import('../connection.js');
      mockConnect.mockReturnValueOnce(new Promise(() => {})); // never resolves
      const promise = slothConnect('amqp://hung', { timeoutMs: 50 });
      promise.catch(() => undefined); // attach handler before advancing
      await vi.advanceTimersByTimeAsync(51);
      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the connection if it resolves after the signal aborted (no leak)', async () => {
    const { slothConnect } = await import('../connection.js');
    const ac = new AbortController();
    let resolveConnect!: (c: typeof mockClient) => void;
    mockConnect.mockReturnValueOnce(
      new Promise<typeof mockClient>((resolve) => {
        resolveConnect = resolve;
      }),
    );

    setTimeout(() => {
      ac.abort(new Error('cancelled'));
    }, 5);
    const promise = slothConnect('amqp://localhost', { signal: ac.signal });
    await expect(promise).rejects.toThrow('cancelled');

    // Loser resolves *after* the race lost — the helper must close it.
    resolveConnect(mockClient);
    await new Promise((r) => setImmediate(r));
    expect(mockClose).toHaveBeenCalled();
  });

  it('closes the client if a setup throws after signal aborts', async () => {
    const { slothConnect } = await import('../connection.js');
    const ac = new AbortController();
    const slowSetup = vi.fn().mockReturnValue(new Promise(() => {})); // never settles
    setTimeout(() => {
      ac.abort(new Error('mid-setup-abort'));
    }, 5);
    await expect(
      slothConnect('amqp://localhost', { signal: ac.signal }, slowSetup),
    ).rejects.toThrow('mid-setup-abort');
    expect(mockClose).toHaveBeenCalled();
  });

  it('accepts options bag followed by setup functions', async () => {
    const { slothConnect } = await import('../connection.js');
    const setup = vi.fn().mockResolvedValue(undefined);
    const client = await slothConnect('amqp://localhost', { timeoutMs: 5_000 }, setup);
    expect(setup).toHaveBeenCalledWith(client);
  });

  it('treats first arg as setup when not an options object (backward compat)', async () => {
    const { slothConnect } = await import('../connection.js');
    const setup = vi.fn().mockResolvedValue(undefined);
    await slothConnect('amqp://localhost', setup);
    expect(setup).toHaveBeenCalledWith(mockClient);
  });

  it('swallows errors from the loser-cleanup close() call', async () => {
    const { slothConnect } = await import('../connection.js');
    const ac = new AbortController();
    let resolveConnect!: (c: typeof mockClient) => void;
    mockConnect.mockReturnValueOnce(
      new Promise<typeof mockClient>((resolve) => {
        resolveConnect = resolve;
      }),
    );
    // close() rejects — the .catch in onLoserSettle must swallow it.
    mockClose.mockRejectedValueOnce(new Error('close-failed'));

    setTimeout(() => {
      ac.abort(new Error('cancelled'));
    }, 5);
    const promise = slothConnect('amqp://localhost', { signal: ac.signal });
    await expect(promise).rejects.toThrow('cancelled');

    resolveConnect(mockClient);
    // Wait long enough for the .catch chain to run; if it didn't swallow, an
    // unhandled rejection would fire and vitest would flag it.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockClose).toHaveBeenCalled();
  });
});

describe('slothClose', () => {
  it('calls close on the client', async () => {
    const { slothClose } = await import('../connection.js');
    await slothClose(mockClient as never);
    expect(mockClose).toHaveBeenCalled();
  });
});
