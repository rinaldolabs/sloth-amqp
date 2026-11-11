import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';
import type { SlothConfig } from '../utils.js';

const testConfig: SlothConfig = { serviceName: 'test-service', routingKey: 'test.key' };

// Fixed point in time for all timing-sensitive tests
const FIXED_NOW_MS = 1_700_000_000_000;
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

// ─── pure helper tests (no mocks needed) ─────────────────────────────────────

describe('resolveDelaySeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves delayMinutes to unix seconds', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const { delayUntilUnix, delayDesc } = resolveDelaySeconds({ delayMinutes: 60 });
    expect(delayUntilUnix).toBe(FIXED_NOW_SEC + 3600);
    expect(delayDesc).toBe('delay=60min');
  });

  it('resolves delaySeconds to unix seconds', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const { delayUntilUnix, delayDesc } = resolveDelaySeconds({ delaySeconds: 90 });
    expect(delayUntilUnix).toBe(FIXED_NOW_SEC + 90);
    expect(delayDesc).toBe('delay=90s');
  });

  it('resolves delayUntil to unix seconds', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const future = new Date(FIXED_NOW_MS + 5 * 60 * 1000);
    const { delayUntilUnix, delayDesc } = resolveDelaySeconds({ delayUntil: future });
    expect(delayUntilUnix).toBe(Math.floor(future.getTime() / 1000));
    expect(delayDesc).toContain('until=');
  });

  it('throws a SlothValidationError when no delay field is provided', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const { SlothValidationError } = await import('../errors.js');
    expect(() => resolveDelaySeconds({} as never)).toThrow('exactly one');
    expect(() => resolveDelaySeconds({} as never)).toThrow(SlothValidationError);
  });

  it('throws when both delayMinutes and delaySeconds are provided', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delayMinutes: 5, delaySeconds: 30 } as never)).toThrow(
      'exactly one',
    );
  });

  it('throws when both delayMinutes and delayUntil are provided', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() =>
      resolveDelaySeconds({
        delayMinutes: 5,
        delayUntil: new Date(FIXED_NOW_MS + 60_000),
      } as never),
    ).toThrow('exactly one');
  });

  it('throws when both delaySeconds and delayUntil are provided', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() =>
      resolveDelaySeconds({
        delaySeconds: 30,
        delayUntil: new Date(FIXED_NOW_MS + 60_000),
      } as never),
    ).toThrow('exactly one');
  });

  it('throws when all three delay fields are provided', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() =>
      resolveDelaySeconds({
        delayMinutes: 5,
        delaySeconds: 30,
        delayUntil: new Date(FIXED_NOW_MS + 60_000),
      } as never),
    ).toThrow('exactly one');
  });

  it('throws if delayMinutes is zero', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delayMinutes: 0 })).toThrow(
      'delayMinutes must be a positive finite number',
    );
  });

  it('throws if delayMinutes is negative', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delayMinutes: -5 })).toThrow('positive finite');
  });

  it('throws if delayMinutes is NaN', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delayMinutes: NaN })).toThrow('positive finite');
  });

  it('throws if delayMinutes is Infinity', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delayMinutes: Infinity })).toThrow('positive finite');
  });

  it('throws if delayMinutes exceeds 100 years', async () => {
    const { resolveDelaySeconds, MAX_DELAY_SECONDS } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delayMinutes: MAX_DELAY_SECONDS / 60 + 1 })).toThrow(
      'exceeds maximum',
    );
  });

  it('throws if delaySeconds is zero', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delaySeconds: 0 })).toThrow(
      'delaySeconds must be a positive finite number',
    );
  });

  it('throws if delaySeconds is negative', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delaySeconds: -1 })).toThrow('positive finite');
  });

  it('throws if delaySeconds is NaN', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delaySeconds: NaN })).toThrow('positive finite');
  });

  it('throws if delaySeconds is Infinity', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delaySeconds: Infinity })).toThrow('positive finite');
  });

  it('throws if delaySeconds exceeds 100 years', async () => {
    const { resolveDelaySeconds, MAX_DELAY_SECONDS } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delaySeconds: MAX_DELAY_SECONDS + 1 })).toThrow(
      'exceeds maximum',
    );
  });

  it('throws if delayUntil is an invalid Date', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    expect(() => resolveDelaySeconds({ delayUntil: new Date('not-a-date') })).toThrow(
      'delayUntil is an invalid Date',
    );
  });

  it('throws a typed error if a JS caller passes a non-Date delayUntil', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const { SlothValidationError } = await import('../errors.js');
    expect(() => resolveDelaySeconds({ delayUntil: 'tomorrow' as never })).toThrow(
      SlothValidationError,
    );
    expect(() => resolveDelaySeconds({ delayUntil: { y: 2030 } as never })).toThrow(
      'delayUntil must be a Date',
    );
  });

  it('returns pastDateWarning when delayUntil is in the past', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const { pastDateWarning } = resolveDelaySeconds({
      delayUntil: new Date(FIXED_NOW_MS - 1000),
    });
    expect(pastDateWarning).toMatch(/past/);
  });

  it('returns no pastDateWarning when delayUntil is in the future', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const { pastDateWarning } = resolveDelaySeconds({
      delayUntil: new Date(FIXED_NOW_MS + 60_000),
    });
    expect(pastDateWarning).toBeUndefined();
  });

  it('rounds delayUntil up to next second (Math.ceil) preserving sub-second precision', async () => {
    const { resolveDelaySeconds } = await import('../sender.js');
    const dateWithMs = new Date(FIXED_NOW_MS + 500); // 500ms into next second
    const { delayUntilUnix } = resolveDelaySeconds({ delayUntil: dateWithMs });
    expect(delayUntilUnix).toBe(Math.ceil((FIXED_NOW_MS + 500) / 1000));
  });

  it('throws if delayUntil exceeds 100 years from now', async () => {
    const { resolveDelaySeconds, MAX_DELAY_SECONDS } = await import('../sender.js');
    const farFuture = new Date(FIXED_NOW_MS + (MAX_DELAY_SECONDS + 1) * 1000);
    expect(() => resolveDelaySeconds({ delayUntil: farFuture })).toThrow('exceeds maximum');
  });
});

describe('sanitizeLabel', () => {
  it('strips ASCII newlines (U+000A)', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('ok\nlabel')).toBe('oklabel');
  });

  it('strips null bytes (U+0000)', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('ok\x00label')).toBe('oklabel');
  });

  it('strips NEL (U+0085)', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('oklabel')).toBe('oklabel');
  });

  it('strips Unicode line separator (U+2028)', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('ok label')).toBe('oklabel');
  });

  it('strips Unicode paragraph separator (U+2029)', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('ok label')).toBe('oklabel');
  });

  it('truncates to 200 grapheme clusters, not code units', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    // Each emoji is 1 grapheme cluster but 2 UTF-16 code units
    const emoji = '😀';
    const result = sanitizeLabel(emoji.repeat(300));
    // Should be exactly 200 emoji — not cut in half
    expect([...result.matchAll(/😀/gu)]).toHaveLength(200);
  });

  it('strips C1 controls (e.g. CSI U+009B) that terminals interpret as escape introducers', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('ok31mlabel')).toBe('ok31mlabel');
  });

  it('strips bidi override and isolate characters', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    // Escapes (not literals) so the file itself trips no trojan-source linting:
    // RLO override, LRI isolate, PDI pop.
    expect(sanitizeLabel('ok\u202Elabel\u2066x\u2069')).toBe('oklabelx');
  });

  it('hard-caps code-unit length even when single graphemes are huge (ZWJ chains)', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    // Family emoji: 1 grapheme cluster, 11 UTF-16 code units. 200 clusters
    // would be 2200 units without the cap.
    const family = '👨‍👩‍👧‍👦';
    const result = sanitizeLabel(family.repeat(300));
    expect(result.length).toBe(400);
  });

  it('passes through safe labels unchanged', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('user-verification')).toBe('user-verification');
  });
});

describe('serializeData', () => {
  it('serializes a plain object to a Buffer', async () => {
    const { serializeData } = await import('../sender.js');
    const buf = serializeData({ key: 'test', n: 42 });
    expect(JSON.parse(buf.toString())).toEqual({ key: 'test', n: 42 });
  });

  it('throws a clear error for circular references', async () => {
    const { serializeData } = await import('../sender.js');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => serializeData(circular)).toThrow('not JSON-serializable');
  });
});

// ─── createDelaySender (AMQP I/O layer) ──────────────────────────────────────

type PublishCallback = (err: Error | null) => void;

type Listener = (...args: unknown[]) => void;

interface MockConfirmChannel {
  assertExchange: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  on: (event: string, listener: Listener) => MockConfirmChannel;
  emit: (event: string, ...args: unknown[]) => void;
  listenerCount: (event: string) => number;
}

const mockPublish = vi.fn();
const mockAssertExchange = vi.fn().mockResolvedValue(undefined);

const buildChannel = (): MockConfirmChannel => {
  const localHandlers = new Map<string, Listener[]>();
  const chan: MockConfirmChannel = {
    assertExchange: mockAssertExchange,
    publish: mockPublish,
    on: (event, listener) => {
      const list = localHandlers.get(event) ?? [];
      list.push(listener);
      localHandlers.set(event, list);
      return chan;
    },
    emit: (event, ...args) => {
      for (const fn of localHandlers.get(event) ?? []) fn(...args);
    },
    listenerCount: (event) => localHandlers.get(event)?.length ?? 0,
  };
  return chan;
};

let mockChannel: MockConfirmChannel = buildChannel();
const mockCreateConfirmChannel = vi.fn().mockImplementation(() => Promise.resolve(mockChannel));
const mockClient = { createConfirmChannel: mockCreateConfirmChannel };

const mockLogger: SlothLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

// Default publish: synchronously invoke the broker-confirm callback with success.
// Tests can override per-call via mockPublish.mockImplementationOnce(...).
const defaultPublishImpl = (
  _ex: string,
  _rk: string,
  _body: Buffer,
  _opts: unknown,
  cb: PublishCallback,
): boolean => {
  cb(null);
  return true;
};

describe('createDelaySender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    mockChannel = buildChannel();
    mockCreateConfirmChannel.mockImplementation(() => Promise.resolve(mockChannel));
    mockPublish.mockImplementation(defaultPublishImpl);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes to the request exchange with correct routing key and headers', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { key: 'test-event' },
      delayMinutes: 30,
      logger: mockLogger,
      config: testConfig,
    });

    expect(mockAssertExchange).toHaveBeenCalledWith(
      'sloth.direct.exchange.request',
      'direct',
      expect.objectContaining({ durable: true }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'sloth.direct.exchange.request',
      'delay',
      expect.any(Buffer),
      expect.objectContaining({
        headers: expect.objectContaining({
          'delay-until': FIXED_NOW_SEC + 30 * 60,
          target: 'amqp://test-service/test.key',
        }),
      }),
      expect.any(Function),
    );
  });

  it('publishes with the exact wire-contract options: persistent, JSON content type, no extras', async () => {
    // Exact-shape assertion (not objectContaining): the durability posture is
    // part of the wire contract — goamqp publishes DeliveryMode 2, and a
    // transient message would be silently lost on broker restart. An exact
    // match also pins that no unexpected option can sneak in.
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { key: 'test-event' },
      delayMinutes: 30,
      logger: mockLogger,
      config: testConfig,
      messageId: 'm-exact',
    });

    const opts = mockPublish.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(opts).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: 'm-exact',
      headers: {
        'delay-until': FIXED_NOW_SEC + 30 * 60,
        target: 'amqp://test-service/test.key',
      },
    });
  });

  it('publishes correct delay-until when using delaySeconds', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { key: 'test' },
      delaySeconds: 90,
      logger: mockLogger,
      config: testConfig,
    });

    const headers = mockPublish.mock.calls[0]?.[3]?.headers as {
      'delay-until': number;
      target: string;
    };
    expect(headers['delay-until']).toBe(FIXED_NOW_SEC + 90);
    expect(headers['target']).toBe('amqp://test-service/test.key');
  });

  it('publishes correct delay-until when using delayUntil', async () => {
    const { createDelaySender } = await import('../sender.js');
    const future = new Date(FIXED_NOW_MS + 5 * 60 * 1000);
    await createDelaySender(mockClient as never).send({
      data: { key: 'test' },
      delayUntil: future,
      logger: mockLogger,
      config: testConfig,
    });

    const headers = mockPublish.mock.calls[0]?.[3]?.headers as {
      'delay-until': number;
      target: string;
    };
    expect(headers['delay-until']).toBe(Math.ceil(future.getTime() / 1000));
    expect(headers['target']).toBe('amqp://test-service/test.key');
  });

  it('logs warn and still publishes when delayUntil is in the past', async () => {
    const { createDelaySender } = await import('../sender.js');
    const past = new Date(FIXED_NOW_MS - 1000);
    await createDelaySender(mockClient as never).send({
      data: { key: 'test' },
      delayUntil: past,
      logger: mockLogger,
      config: testConfig,
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('past'),
      expect.objectContaining({ event: 'sloth.publish.past_date_warning' }),
    );
    expect(mockPublish).toHaveBeenCalled();
  });

  it('rejects when assertExchange throws on first call', async () => {
    const { createDelaySender } = await import('../sender.js');
    mockAssertExchange.mockRejectedValueOnce(new Error('exchange error'));
    await expect(
      createDelaySender(mockClient as never).send({
        data: { key: 'test' },
        delayMinutes: 5,
        logger: mockLogger,
        config: testConfig,
      }),
    ).rejects.toThrow('exchange error');
  });

  it('wraps a foreign assertExchange failure as SlothPublishError with the cause chained', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothPublishError } = await import('../errors.js');
    const broker = new Error('PRECONDITION_FAILED');
    mockAssertExchange.mockRejectedValueOnce(broker);
    const rejection = await createDelaySender(mockClient as never)
      .send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(rejection).toBeInstanceOf(SlothPublishError);
    if (!(rejection instanceof SlothPublishError)) throw new Error('unreachable');
    expect(rejection.code).toBe('SLOTH_PUBLISH');
    expect(rejection.cause).toBe(broker);
  });

  it('wraps a foreign createConfirmChannel failure as SlothPublishError', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothPublishError } = await import('../errors.js');
    mockCreateConfirmChannel.mockRejectedValueOnce(new Error('no channels left'));
    await expect(
      createDelaySender(mockClient as never).send({
        data: { n: 1 },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
      }),
    ).rejects.toBeInstanceOf(SlothPublishError);
  });

  it('rejects with a SlothPublishError when broker nacks the publish (callback err)', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothPublishError } = await import('../errors.js');
    mockPublish.mockImplementationOnce(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: PublishCallback): boolean => {
        cb(new Error('broker nacked'));
        return true;
      },
    );
    await expect(
      createDelaySender(mockClient as never).send({
        data: { key: 'test' },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
      }),
    ).rejects.toThrow(SlothPublishError);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to schedule'),
      expect.objectContaining({ event: 'sloth.publish.failed' }),
    );
  });

  it('wraps a non-Error broker reject value in an Error', async () => {
    const { createDelaySender } = await import('../sender.js');
    mockPublish.mockImplementationOnce(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: PublishCallback): boolean => {
        // amqplib's callback is typed `(err: any) => void`; some transports surface a plain string
        (cb as (err: unknown) => void)('broker timeout');
        return true;
      },
    );
    await expect(
      createDelaySender(mockClient as never).send({
        data: { key: 'test' },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
      }),
    ).rejects.toThrow('broker timeout');
  });

  it('throws without opening a channel when data is not JSON-serializable', async () => {
    const { createDelaySender } = await import('../sender.js');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(
      createDelaySender(mockClient as never).send({
        data: circular,
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
      }),
    ).rejects.toThrow('not JSON-serializable');
    expect(mockCreateConfirmChannel).not.toHaveBeenCalled();
  });

  it('throws without opening a channel when config is invalid', async () => {
    const { createDelaySender } = await import('../sender.js');
    await expect(
      createDelaySender(mockClient as never).send({
        data: { key: 'test' },
        delayMinutes: 1,
        logger: mockLogger,
        config: { serviceName: 'bad/name', routingKey: 'k' },
      }),
    ).rejects.toThrow('serviceName');
    expect(mockCreateConfirmChannel).not.toHaveBeenCalled();
  });

  it('throws when createConfirmChannel fails', async () => {
    const { createDelaySender } = await import('../sender.js');
    mockCreateConfirmChannel.mockRejectedValueOnce(new Error('no channel'));
    await expect(
      createDelaySender(mockClient as never).send({
        data: { key: 'test' },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
      }),
    ).rejects.toThrow('no channel');
  });

  it('warns when publish returns false (back-pressure) but still resolves on broker ack', async () => {
    const { createDelaySender } = await import('../sender.js');
    mockPublish.mockImplementationOnce(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: PublishCallback): boolean => {
        cb(null);
        return false;
      },
    );
    await createDelaySender(mockClient as never).send({
      data: { key: 'test' },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('back-pressured'),
      expect.objectContaining({ event: 'sloth.publish.back_pressured' }),
    );
  });

  it('rejects with SlothTimeoutError when the confirm does not arrive in time', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothTimeoutError } = await import('../errors.js');
    // publish never invokes the confirm callback → confirm hangs.
    mockPublish.mockImplementationOnce(() => true);
    const { send } = createDelaySender(mockClient as never);
    const promise = send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      timeoutMs: 50,
    });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(51);
    await expect(promise).rejects.toBeInstanceOf(SlothTimeoutError);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to schedule'),
      expect.objectContaining({ event: 'sloth.publish.failed' }),
    );
  });

  it('keeps the cached channel after a publish timeout (does not recreate)', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);
    // First send times out (no confirm callback)...
    mockPublish.mockImplementationOnce(() => true);
    const p1 = send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      timeoutMs: 50,
    });
    p1.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(51);
    await expect(p1).rejects.toThrow();
    // ...the next send reuses the same channel (default publish impl confirms).
    await send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(1);
  });

  it('drops a late confirm callback that fires after the timeout (no throw)', async () => {
    const { createDelaySender } = await import('../sender.js');
    let lateCb: PublishCallback | undefined;
    mockPublish.mockImplementationOnce(
      (_ex: string, _rk: string, _body: Buffer, _opts: unknown, cb: PublishCallback): boolean => {
        lateCb = cb;
        return true;
      },
    );
    const { send } = createDelaySender(mockClient as never);
    const promise = send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      timeoutMs: 50,
    });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(51);
    await expect(promise).rejects.toThrow();
    // The broker confirm arrives late — the settled guard must make it a no-op.
    expect(() => {
      lateCb?.(null);
    }).not.toThrow();
  });

  it('throws immediately when the caller signal is already aborted, with zero AMQP work', async () => {
    const { createDelaySender } = await import('../sender.js');
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    await expect(
      createDelaySender(mockClient as never).send({
        data: { n: 1 },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
        signal: ac.signal,
      }),
    ).rejects.toThrow('pre-aborted');
    expect(mockCreateConfirmChannel).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects without publishing when the caller aborts during a pending channel acquire', async () => {
    // The acquire phase is raced against the signal too — a hung
    // createConfirmChannel (black-hole partition) must not let send() sail
    // past its deadline, and a cancelled send must never publish.
    const { createDelaySender } = await import('../sender.js');
    const reason = new Error('caller gave up');
    const ac = new AbortController();
    mockCreateConfirmChannel.mockReturnValueOnce(new Promise(() => {})); // hung
    const { send } = createDelaySender(mockClient as never);
    const promise = send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      signal: ac.signal,
    });
    promise.catch(() => undefined);
    ac.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not publish when the abort fires in the same tick the cached channel resolves', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);
    // First send caches the channel.
    await send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    // Second send: the acquire resolves from cache (already-settled promise
    // wins the race), but the abort fired before publish — the re-check must
    // reject with the caller's reason and skip the publish.
    const reason = new Error('too late');
    const ac = new AbortController();
    const promise = send({
      data: { n: 2 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      signal: ac.signal,
    });
    promise.catch(() => undefined);
    ac.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(mockPublish).toHaveBeenCalledTimes(1); // only the first send published
  });

  it('propagates a caller abort during the confirm wait verbatim and keeps the channel', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothTimeoutError } = await import('../errors.js');
    // Confirm callback withheld — the publish hangs at the confirm wait.
    mockPublish.mockImplementationOnce(() => true);
    const reason = new Error('shutdown requested');
    const ac = new AbortController();
    const { send } = createDelaySender(mockClient as never);
    const promise = send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      signal: ac.signal,
    });
    promise.catch(() => undefined);
    // Poll until the publish has actually been issued — only then is send()
    // parked on the confirm wait that the abort must interrupt.
    while (mockPublish.mock.calls.length === 0) await Promise.resolve();
    ac.abort(reason);
    // Caller abort → reason verbatim, never normalised to SlothTimeoutError.
    const rejection = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(rejection).toBe(reason);
    expect(rejection).not.toBeInstanceOf(SlothTimeoutError);

    // The channel stays cached — the message may still confirm.
    await send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(1);
  });

  it('suppresses debug and info logs when logLevel is error', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { key: 'test' },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      logLevel: 'error',
    });
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('uses sanitized logLabel in log output', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { x: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      logLabel: 'reminder',
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('reminder'),
      expect.objectContaining({ event: 'sloth.publish.confirmed' }),
    );
  });

  it('reuses the same channel and asserts the exchange only once across calls', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);
    await send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    await send({ data: { n: 2 }, delayMinutes: 2, logger: mockLogger, config: testConfig });
    await send({ data: { n: 3 }, delayMinutes: 3, logger: mockLogger, config: testConfig });

    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(1);
    expect(mockAssertExchange).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(3);
  });

  it('re-creates the channel after a channel close event', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);
    await send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    // Broker closes the first channel; next send must open a new one and re-assert.
    mockChannel.emit('close');
    mockChannel = buildChannel();
    mockCreateConfirmChannel.mockImplementationOnce(() => Promise.resolve(mockChannel));

    await send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(2);
    expect(mockAssertExchange).toHaveBeenCalledTimes(2);
  });

  it('re-creates the channel after a channel error event', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);
    await send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    mockChannel.emit('error');
    mockChannel = buildChannel();
    mockCreateConfirmChannel.mockImplementationOnce(() => Promise.resolve(mockChannel));

    await send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(2);
    expect(mockAssertExchange).toHaveBeenCalledTimes(2);
  });

  it('shares one channel-creation across concurrent first sends (no leak)', async () => {
    // Multiple send() calls fired before the first createConfirmChannel resolves
    // must all share the same in-flight acquire — otherwise each would create
    // its own channel and only the last would win the cache, leaking the rest.
    let resolveCreate: (chan: MockConfirmChannel) => void = () => {};
    mockCreateConfirmChannel.mockImplementationOnce(
      () =>
        new Promise<MockConfirmChannel>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);

    const p1 = send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    const p2 = send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    const p3 = send({ data: { n: 3 }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    resolveCreate(mockChannel);
    await Promise.all([p1, p2, p3]);

    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(1);
    expect(mockAssertExchange).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(3);
  });

  it('closes the orphan channel and clears state when assertExchange fails', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const failingChannel = { ...mockChannel, close: closeSpy };
    mockCreateConfirmChannel.mockImplementationOnce(() => Promise.resolve(failingChannel));
    mockAssertExchange.mockRejectedValueOnce(new Error('exchange-locked'));

    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);

    await expect(
      send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('exchange-locked');

    // Orphan channel was closed best-effort.
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Next send retries cleanly with a fresh channel.
    await send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(2);
  });

  it('swallows close() errors when cleaning up after assertExchange failure', async () => {
    // The orphan-cleanup path must not throw if the channel is already broken
    // and rejects on close — we still want the original assertExchange error
    // to surface.
    const closeSpy = vi.fn().mockRejectedValue(new Error('already closed'));
    const failingChannel = { ...mockChannel, close: closeSpy };
    mockCreateConfirmChannel.mockImplementationOnce(() => Promise.resolve(failingChannel));
    mockAssertExchange.mockRejectedValueOnce(new Error('exchange-locked'));

    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);

    await expect(
      send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('exchange-locked');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects and clears state when channel dies before assertExchange resolves', async () => {
    // If error/close fires while assertExchange is in flight, the in-progress
    // acquire must reject (don't cache a dead channel) and the next send must
    // start a fresh acquire — otherwise a subsequent caller would either wait
    // forever or get back a known-dead channel.
    let resolveAssert: () => void = () => {};
    const flag = { assertCalled: false };
    mockAssertExchange.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          flag.assertCalled = true;
          resolveAssert = () => {
            resolve();
          };
        }),
    );

    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);

    const p1 = send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    // Wait until open() has progressed far enough to call assertExchange — that
    // means createConfirmChannel resolved and the error/close listeners are wired up.
    while (!flag.assertCalled) await Promise.resolve();

    // Now the channel can be killed and the listener will fire synchronously.
    mockChannel.emit('close');
    resolveAssert();

    await expect(p1).rejects.toThrow('closed before publisher was ready');

    // The next send must start a brand-new acquire — not reuse the dead one.
    mockChannel = buildChannel();
    mockCreateConfirmChannel.mockImplementationOnce(() => Promise.resolve(mockChannel));
    await send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(2);
  });

  it('does not let a failed open clobber a newer in-flight acquire', async () => {
    // Sequence: open #1's channel dies mid-assertExchange (invalidate clears
    // the in-flight slot) → a new send starts open #2 → open #1 finally fails.
    // Its cleanup must NOT null out open #2's in-flight state — a third send
    // must join open #2 instead of starting a third channel.
    const chan1 = buildChannel();
    const chan2 = buildChannel();
    let resolveAssert1: () => void = () => {};
    let resolveAssert2: () => void = () => {};
    const flags = { assert1Called: false, assert2Called: false };
    mockCreateConfirmChannel
      .mockImplementationOnce(() => Promise.resolve(chan1))
      .mockImplementationOnce(() => Promise.resolve(chan2));
    mockAssertExchange
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            flags.assert1Called = true;
            resolveAssert1 = () => {
              resolve();
            };
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            flags.assert2Called = true;
            resolveAssert2 = () => {
              resolve();
            };
          }),
      );

    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);

    const p1 = send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    while (!flags.assert1Called) await Promise.resolve();

    // Channel #1 dies mid-open — invalidate frees the in-flight slot.
    chan1.emit('close');

    // A new send starts open #2 while open #1 is still unwinding.
    const p2 = send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    while (!flags.assert2Called) await Promise.resolve();

    // Open #1 now fails; its finally must leave open #2's state alone.
    resolveAssert1();
    await expect(p1).rejects.toThrow('closed before publisher was ready');

    // A third send must join the pending open #2, not create a third channel.
    const p3 = send({ data: { n: 3 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    resolveAssert2();
    await Promise.all([p2, p3]);

    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale close event on a channel that was already replaced', async () => {
    // A channel emits 'close' *after* the cache has moved on to a new channel
    // (a race between broker-initiated close and our re-create on error).
    // The `cached === chan` guard must keep the new channel intact.
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never);
    await send({ data: { n: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    const oldChannel = mockChannel;

    // Force a swap to a new channel
    mockChannel.emit('error');
    mockChannel = buildChannel();
    mockCreateConfirmChannel.mockImplementationOnce(() => Promise.resolve(mockChannel));
    await send({ data: { n: 2 }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    // Now the *old* channel finally fires close — must not invalidate the new one
    oldChannel.emit('close');
    await send({ data: { n: 3 }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    // Only two channels created total; the stale event was ignored
    expect(mockCreateConfirmChannel).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledTimes(3);
  });

  it('auto-generates a UUID messageId when caller does not provide one', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
    });

    const opts = mockPublish.mock.calls[0]?.[3] as { messageId?: string };
    expect(opts.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('uses caller-supplied messageId verbatim', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      messageId: 'custom-id-123',
    });

    const opts = mockPublish.mock.calls[0]?.[3] as { messageId: string };
    expect(opts.messageId).toBe('custom-id-123');
  });

  it('forwards correlationId on the AMQP basic properties when provided', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      correlationId: 'corr-abc',
    });

    const opts = mockPublish.mock.calls[0]?.[3] as { correlationId?: string };
    expect(opts.correlationId).toBe('corr-abc');
  });

  it('omits correlationId from publish options when not provided', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
    });

    const opts = mockPublish.mock.calls[0]?.[3] as Record<string, unknown>;
    expect('correlationId' in opts).toBe(false);
  });

  it('merges caller-supplied headers (e.g. W3C traceparent) onto the message', async () => {
    const { createDelaySender } = await import('../sender.js');
    await createDelaySender(mockClient as never).send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'congo=t61rcWkgMzE',
      },
    });

    const opts = mockPublish.mock.calls[0]?.[3] as { headers: Record<string, unknown> };
    expect(opts.headers['traceparent']).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
    expect(opts.headers['tracestate']).toBe('congo=t61rcWkgMzE');
    // Reserved headers still present and not overwritten.
    expect(opts.headers['delay-until']).toBe(FIXED_NOW_SEC + 60);
    expect(opts.headers['target']).toBe('amqp://test-service/test.key');
  });

  it('throws when caller-supplied headers include the reserved delay-until key', async () => {
    const { createDelaySender } = await import('../sender.js');
    await expect(
      createDelaySender(mockClient as never).send({
        data: { n: 1 },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
        headers: { 'delay-until': 999 },
      }),
    ).rejects.toThrow('headers.delay-until is reserved');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('throws when caller-supplied headers include the reserved target key', async () => {
    const { createDelaySender } = await import('../sender.js');
    await expect(
      createDelaySender(mockClient as never).send({
        data: { n: 1 },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
        headers: { target: 'amqp://evil/path' },
      }),
    ).rejects.toThrow('headers.target is reserved');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('emits an outbound wire event after the publish is confirmed', async () => {
    const { createDelaySender } = await import('../sender.js');
    const onWireMessage = vi.fn();
    await createDelaySender(mockClient as never).send({
      data: { n: 1 },
      delayMinutes: 1,
      logger: mockLogger,
      config: testConfig,
      messageId: 'm-out',
      correlationId: 'c-out',
      onWireMessage,
    });
    expect(onWireMessage).toHaveBeenCalledTimes(1);
    const evt = onWireMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(evt['direction']).toBe('out');
    expect(evt['exchange']).toBe('sloth.direct.exchange.request');
    expect(evt['routingKey']).toBe('delay');
    expect(Buffer.isBuffer(evt['content'])).toBe(true);
    expect(evt['messageId']).toBe('m-out');
    expect(evt['correlationId']).toBe('c-out');
  });

  it('does not let a throwing wire hook fail the send', async () => {
    const { createDelaySender } = await import('../sender.js');
    const onWireMessage = vi.fn(() => {
      throw new Error('observer boom');
    });
    await expect(
      createDelaySender(mockClient as never).send({
        data: { n: 1 },
        delayMinutes: 1,
        logger: mockLogger,
        config: testConfig,
        onWireMessage,
      }),
    ).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('observer boom'),
      expect.objectContaining({ event: 'sloth.wire.hook_failed', direction: 'out' }),
    );
  });
});

// ─── createDelaySender with mandatory ────────────────────────────────────────

interface CapturedPublish {
  options: { mandatory?: boolean; headers: Record<string, unknown> };
  confirm: PublishCallback;
}

describe('createDelaySender mandatory option', () => {
  let published: CapturedPublish[];
  const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
  const publishIdOf = (index: number): unknown =>
    published.at(index)?.options.headers['x-sloth-publish-id'];
  const returnOf = (publishId: unknown, headers?: Record<string, unknown>) => ({
    fields: {},
    content: Buffer.alloc(0),
    properties: { headers: headers ?? { 'x-sloth-publish-id': publishId } },
  });
  const params = (extra: Record<string, unknown> = {}) => ({
    data: { n: 1 },
    delayMinutes: 1,
    logger: mockLogger,
    config: testConfig,
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    mockChannel = buildChannel();
    mockCreateConfirmChannel.mockImplementation(() => Promise.resolve(mockChannel));
    published = [];
    mockPublish.mockImplementation(
      (
        _ex: string,
        _rk: string,
        _body: Buffer,
        options: CapturedPublish['options'],
        confirm: PublishCallback,
      ) => {
        published.push({ options, confirm });
        return true;
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['omitted', undefined],
    ['false', { mandatory: false }],
  ])('publishes exactly as before when mandatory is %s', async (_label, options) => {
    const { createDelaySender } = await import('../sender.js');
    const promise = createDelaySender(mockClient as never, options).send(
      params({ messageId: 'm-1' }),
    );
    await flush();
    expect(published[0]?.options).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: 'm-1',
      headers: { 'delay-until': FIXED_NOW_SEC + 60, target: 'amqp://test-service/test.key' },
    });
    expect(mockChannel.listenerCount('return')).toBe(0);
    published[0]?.confirm(null);
    await expect(promise).resolves.toBeUndefined();
  });

  it.each([
    ['omitted', undefined],
    ['false', { mandatory: false }],
  ])('passes a caller x-sloth-publish-id header through when mandatory is %s', async (_l, o) => {
    const { createDelaySender } = await import('../sender.js');
    const promise = createDelaySender(mockClient as never, o).send(
      params({ headers: { 'x-sloth-publish-id': 'caller-value' } }),
    );
    await flush();
    expect(publishIdOf(0)).toBe('caller-value');
    published[0]?.confirm(null);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects a caller x-sloth-publish-id header before any I/O when mandatory is on', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothValidationError } = await import('../errors.js');
    await expect(
      createDelaySender(mockClient as never, { mandatory: true }).send(
        params({ headers: { 'x-sloth-publish-id': 'caller-value' } }),
      ),
    ).rejects.toBeInstanceOf(SlothValidationError);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('sets mandatory and a fresh publish id that the wire tap shows after the confirm', async () => {
    const { createDelaySender } = await import('../sender.js');
    const onWireMessage = vi.fn();
    const promise = createDelaySender(mockClient as never, { mandatory: true }).send(
      params({ onWireMessage }),
    );
    await flush();
    expect(published[0]?.options.mandatory).toBe(true);
    expect(publishIdOf(0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockChannel.listenerCount('return')).toBe(1);
    published[0]?.confirm(null);
    await expect(promise).resolves.toBeUndefined();
    expect(onWireMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-sloth-publish-id': publishIdOf(0) }),
      }),
    );
  });

  it('rejects an unroutable send when the return precedes its confirm', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothPublishError } = await import('../errors.js');
    const promise = createDelaySender(mockClient as never, { mandatory: true }).send(params());
    promise.catch(() => undefined);
    await flush();
    mockChannel.emit('return', returnOf(publishIdOf(0)));
    published[0]?.confirm(null);
    await expect(promise).rejects.toBeInstanceOf(SlothPublishError);
    await expect(promise).rejects.toThrow('unroutable');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to schedule'),
      expect.objectContaining({ event: 'sloth.publish.failed' }),
    );
  });

  it.each([
    ['returned first', [0, 1]],
    ['routed first', [1, 0]],
  ])(
    'rejects only the returned send when two share a messageId (confirm of the %s)',
    async (_label, order) => {
      const { createDelaySender } = await import('../sender.js');
      const { send } = createDelaySender(mockClient as never, { mandatory: true });
      const returnedSend = send(params({ messageId: 'same' }));
      const routedSend = send(params({ messageId: 'same' }));
      returnedSend.catch(() => undefined);
      await flush();
      mockChannel.emit('return', returnOf(publishIdOf(0)));
      for (const index of order) published.at(index)?.confirm(null);
      await expect(returnedSend).rejects.toThrow('unroutable');
      await expect(routedSend).resolves.toBeUndefined();
    },
  );

  it('ignores a return for an unknown, settled or malformed publish id', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never, { mandatory: true });
    const first = send(params());
    await flush();
    published[0]?.confirm(null);
    await expect(first).resolves.toBeUndefined();
    const second = send(params());
    await flush();
    mockChannel.emit('return', returnOf(publishIdOf(0)));
    mockChannel.emit('return', returnOf('not-a-pending-id'));
    mockChannel.emit('return', returnOf(undefined, { 'x-sloth-publish-id': 42 }));
    mockChannel.emit('return', { fields: {}, content: Buffer.alloc(0), properties: {} });
    published[1]?.confirm(null);
    await expect(second).resolves.toBeUndefined();
  });

  it('rejects with the nack error when a return is followed by a nack', async () => {
    const { createDelaySender } = await import('../sender.js');
    const promise = createDelaySender(mockClient as never, { mandatory: true }).send(params());
    promise.catch(() => undefined);
    await flush();
    mockChannel.emit('return', returnOf(publishIdOf(0)));
    published[0]?.confirm(new Error('broker nacked'));
    await expect(promise).rejects.toThrow('broker nacked');
  });

  it('rejects each pending send once when the channel closes, without touching a newer channel', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { send } = createDelaySender(mockClient as never, { mandatory: true });
    const oldChannel = mockChannel;
    const pendingA = send(params());
    const pendingB = send(params());
    pendingA.catch(() => undefined);
    pendingB.catch(() => undefined);
    await flush();
    oldChannel.emit('close');
    mockChannel = buildChannel();
    mockCreateConfirmChannel.mockImplementationOnce(() => Promise.resolve(mockChannel));
    const fresh = send(params());
    await flush();
    // amqplib fails every outstanding confirm with a plain Error on close.
    published[0]?.confirm(new Error('channel closed'));
    published[1]?.confirm(new Error('channel closed'));
    // A late return on the closed channel names only that channel's own ids.
    oldChannel.emit('return', returnOf(publishIdOf(0)));
    published[2]?.confirm(null);
    await expect(pendingA).rejects.toThrow('channel closed');
    await expect(pendingB).rejects.toThrow('channel closed');
    await expect(fresh).resolves.toBeUndefined();
  });

  it.each([
    [
      'IllegalOperationError',
      Object.assign(new Error('Channel closed'), { name: 'IllegalOperationError' }),
    ],
    ['RangeError', new RangeError('header table exceeds the encoding buffer')],
  ])('rejects and forgets the publish id when publish throws %s', async (_label, thrown) => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothPublishError } = await import('../errors.js');
    mockPublish.mockImplementationOnce(() => {
      throw thrown;
    });
    const { send } = createDelaySender(mockClient as never, { mandatory: true });
    await expect(send(params())).rejects.toBeInstanceOf(SlothPublishError);
    const next = send(params());
    await flush();
    published[0]?.confirm(null);
    await expect(next).resolves.toBeUndefined();
  });

  it('keeps tracking a timed-out send until its late return and confirm arrive', async () => {
    const { createDelaySender } = await import('../sender.js');
    const { SlothTimeoutError } = await import('../errors.js');
    const promise = createDelaySender(mockClient as never, { mandatory: true }).send(
      params({ timeoutMs: 50 }),
    );
    promise.catch(() => undefined);
    await flush();
    await vi.advanceTimersByTimeAsync(51);
    await expect(promise).rejects.toBeInstanceOf(SlothTimeoutError);
    mockChannel.emit('return', returnOf(publishIdOf(0)));
    expect(() => published[0]?.confirm(null)).not.toThrow();
  });
});
