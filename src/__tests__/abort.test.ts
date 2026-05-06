import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { combineAbort, raceWithAbort, safeClose } from '../abort.js';

describe('safeClose', () => {
  it('resolves when close() resolves', async () => {
    const resource = { close: vi.fn().mockResolvedValue('ok') };
    await expect(safeClose(resource)).resolves.toBeUndefined();
    expect(resource.close).toHaveBeenCalled();
  });

  it('resolves (does not throw) when close() rejects', async () => {
    const resource = { close: vi.fn().mockRejectedValue(new Error('close-failed')) };
    await expect(safeClose(resource)).resolves.toBeUndefined();
  });
});

describe('combineAbort', () => {
  it('returns undefined when neither signal nor timeoutMs is provided', () => {
    expect(combineAbort(undefined, undefined)).toBeUndefined();
  });

  it('returns the caller signal when timeoutMs is absent', () => {
    const ac = new AbortController();
    expect(combineAbort(ac.signal, undefined)).toBe(ac.signal);
  });

  it('returns a fresh signal when only timeoutMs is provided', () => {
    const sig = combineAbort(undefined, 50);
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig?.aborted).toBe(false);
  });

  it('composes both via AbortSignal.any so first abort wins', () => {
    const ac = new AbortController();
    const sig = combineAbort(ac.signal, 60_000);
    expect(sig).toBeInstanceOf(AbortSignal);
    ac.abort(new Error('caller-cancelled'));
    // AbortSignal.any propagates synchronously on abort dispatch.
    expect(sig?.aborted).toBe(true);
    expect((sig?.reason as Error).message).toBe('caller-cancelled');
  });

  it('throws when timeoutMs is zero', () => {
    expect(() => combineAbort(undefined, 0)).toThrow('positive finite');
  });

  it('throws when timeoutMs is negative', () => {
    expect(() => combineAbort(undefined, -1)).toThrow('positive finite');
  });

  it('throws when timeoutMs is NaN', () => {
    expect(() => combineAbort(undefined, NaN)).toThrow('positive finite');
  });

  it('throws when timeoutMs is Infinity', () => {
    expect(() => combineAbort(undefined, Infinity)).toThrow('positive finite');
  });
});

describe('raceWithAbort', () => {
  it('returns the input promise unchanged when no signal is provided', async () => {
    await expect(raceWithAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok');
  });

  it('throws signal.reason immediately if signal is already aborted', async () => {
    const ac = new AbortController();
    const reason = new Error('already-aborted');
    ac.abort(reason);
    await expect(raceWithAbort(Promise.resolve('never'), ac.signal)).rejects.toBe(reason);
  });

  it('resolves with the input value when the promise wins the race', async () => {
    const ac = new AbortController();
    await expect(raceWithAbort(Promise.resolve(42), ac.signal)).resolves.toBe(42);
    // Listener was removed in finally — we cannot directly inspect, but the
    // signal should still be unaborted and reusable.
    expect(ac.signal.aborted).toBe(false);
  });

  it('rejects with signal.reason when abort wins the race', async () => {
    const ac = new AbortController();
    const slow = new Promise((resolve) => setTimeout(resolve, 1_000, 'slow'));
    const reason = new Error('cancelled');
    setTimeout(() => {
      ac.abort(reason);
    }, 5);
    await expect(raceWithAbort(slow, ac.signal)).rejects.toBe(reason);
  });

  it('passes the loser-promise resolution to onLoserSettle for cleanup', async () => {
    const ac = new AbortController();
    const cleanup = vi.fn();
    let resolveLoser!: (v: { id: string }) => void;
    const loser = new Promise<{ id: string }>((resolve) => {
      resolveLoser = resolve;
    });

    setTimeout(() => {
      ac.abort(new Error('abort'));
    }, 5);
    await expect(raceWithAbort(loser, ac.signal, cleanup)).rejects.toThrow('abort');

    // Now the loser resolves *after* the race lost — cleanup must fire.
    resolveLoser({ id: 'leaked-resource' });
    await new Promise((r) => setImmediate(r));
    expect(cleanup).toHaveBeenCalledWith({ id: 'leaked-resource' });
  });

  it('swallows loser-promise rejection so it never surfaces as unhandled', async () => {
    const ac = new AbortController();
    const loser = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('late-failure'));
      }, 10);
    });
    setTimeout(() => {
      ac.abort(new Error('abort-first'));
    }, 1);
    await expect(raceWithAbort(loser, ac.signal)).rejects.toThrow('abort-first');
    // Wait long enough for the late rejection to land.
    await new Promise((r) => setTimeout(r, 20));
    // If the rejection had been unhandled, vitest would have flagged it.
    expect(true).toBe(true);
  });

  it('swallows loser-promise rejection when signal was already aborted at entry (no cleanup)', async () => {
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted-no-cleanup'));
    const loser = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('late-failure'));
      }, 10);
    });
    await expect(raceWithAbort(loser, ac.signal)).rejects.toThrow('pre-aborted-no-cleanup');
    // Wait for the late rejection — no unhandled-rejection should fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(true).toBe(true);
  });

  it('runs onLoserSettle cleanup even when signal was already aborted at entry', async () => {
    const ac = new AbortController();
    const cleanup = vi.fn();
    ac.abort(new Error('pre-aborted'));
    let resolveLoser!: (v: string) => void;
    const loser = new Promise<string>((resolve) => {
      resolveLoser = resolve;
    });

    await expect(raceWithAbort(loser, ac.signal, cleanup)).rejects.toThrow('pre-aborted');
    resolveLoser('leaked');
    await new Promise((r) => setImmediate(r));
    expect(cleanup).toHaveBeenCalledWith('leaked');
  });

  it('removes the abort listener on success path', async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    await raceWithAbort(Promise.resolve('done'), ac.signal);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('propagates non-Error abort reasons verbatim', async () => {
    const ac = new AbortController();
    ac.abort('string-reason');
    await expect(raceWithAbort(Promise.resolve('x'), ac.signal)).rejects.toBe('string-reason');
  });

  it('propagates DOMException(TimeoutError) from AbortSignal.timeout', async () => {
    vi.useFakeTimers();
    try {
      const sig = AbortSignal.timeout(100);
      const slow = new Promise((resolve) => setTimeout(resolve, 10_000, 'too-slow'));
      const promise = raceWithAbort(slow, sig);
      await vi.advanceTimersByTimeAsync(101);
      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Restore globals after each test to keep workers clean.
beforeEach(() => {
  // no-op; here only for the symmetry vitest's lint rule expects
});
afterEach(() => {
  vi.useRealTimers();
});
