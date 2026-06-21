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

interface MockConfirmChannel {
  assertExchange: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  on: (event: string, listener: () => void) => MockConfirmChannel;
  emit: (event: string) => void;
}

const mockPublish = vi.fn();
const mockAssertExchange = vi.fn().mockResolvedValue(undefined);

const buildChannel = (): MockConfirmChannel => {
  const localHandlers = new Map<string, Array<() => void>>();
  const chan: MockConfirmChannel = {
    assertExchange: mockAssertExchange,
    publish: mockPublish,
    on: (event, listener) => {
      const list = localHandlers.get(event) ?? [];
      list.push(listener);
      localHandlers.set(event, list);
      return chan;
    },
    emit: (event) => {
      for (const fn of localHandlers.get(event) ?? []) fn();
    },
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
