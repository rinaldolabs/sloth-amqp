import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';
import type { SlothConfig } from '../utils.js';

const testConfig: SlothConfig = { serviceName: 'test-service', routingKey: 'test.key' };

// ─── pure helper tests (no mocks needed) ─────────────────────────────────────

describe('resolveDelayUnixSeconds', () => {
  it('resolves delayMinutes to unix seconds', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    const before = Math.floor(Date.now() / 1000);
    const { delayUntilUnix, delayDesc } = resolveDelayUnixSeconds({ delayMinutes: 60 });
    expect(delayUntilUnix).toBeGreaterThanOrEqual(before + 3600);
    expect(delayUntilUnix).toBeLessThan(before + 3601);
    expect(delayDesc).toBe('delay=60min');
  });

  it('resolves delaySeconds to unix seconds', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    const before = Math.floor(Date.now() / 1000);
    const { delayUntilUnix, delayDesc } = resolveDelayUnixSeconds({ delaySeconds: 90 });
    expect(delayUntilUnix).toBeGreaterThanOrEqual(before + 90);
    expect(delayUntilUnix).toBeLessThan(before + 91);
    expect(delayDesc).toBe('delay=90s');
  });

  it('resolves delayUntil to unix seconds', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    const future = new Date(Date.now() + 5 * 60 * 1000);
    const { delayUntilUnix, delayDesc } = resolveDelayUnixSeconds({ delayUntil: future });
    expect(delayUntilUnix).toBe(Math.floor(future.getTime() / 1000));
    expect(delayDesc).toContain('until=');
  });

  it('throws if delayMinutes is zero', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delayMinutes: 0 })).toThrow('delayMinutes must be a positive finite number');
  });

  it('throws if delayMinutes is negative', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delayMinutes: -5 })).toThrow('positive finite');
  });

  it('throws if delayMinutes is NaN', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delayMinutes: NaN })).toThrow('positive finite');
  });

  it('throws if delayMinutes is Infinity', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delayMinutes: Infinity })).toThrow('positive finite');
  });

  it('throws if delayMinutes exceeds 100 years', async () => {
    const { resolveDelayUnixSeconds, MAX_DELAY_SECONDS } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delayMinutes: (MAX_DELAY_SECONDS / 60) + 1 })).toThrow('exceeds maximum');
  });

  it('throws if delaySeconds is zero', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delaySeconds: 0 })).toThrow('delaySeconds must be a positive finite number');
  });

  it('throws if delaySeconds is negative', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delaySeconds: -1 })).toThrow('positive finite');
  });

  it('throws if delaySeconds is NaN', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delaySeconds: NaN })).toThrow('positive finite');
  });

  it('throws if delaySeconds is Infinity', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delaySeconds: Infinity })).toThrow('positive finite');
  });

  it('throws if delaySeconds exceeds 100 years', async () => {
    const { resolveDelayUnixSeconds, MAX_DELAY_SECONDS } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delaySeconds: MAX_DELAY_SECONDS + 1 })).toThrow('exceeds maximum');
  });

  it('throws if delayUntil is an invalid Date', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delayUntil: new Date('not-a-date') })).toThrow('delayUntil is an invalid Date');
  });

  it('throws if delayUntil is in the past', async () => {
    const { resolveDelayUnixSeconds } = await import('../sender.js');
    expect(() => resolveDelayUnixSeconds({ delayUntil: new Date(Date.now() - 1000) })).toThrow('delayUntil must be in the future');
  });

  it('throws if delayUntil exceeds 100 years from now', async () => {
    const { resolveDelayUnixSeconds, MAX_DELAY_SECONDS } = await import('../sender.js');
    const farFuture = new Date(Date.now() + (MAX_DELAY_SECONDS + 1) * 1000);
    expect(() => resolveDelayUnixSeconds({ delayUntil: farFuture })).toThrow('exceeds maximum');
  });
});

describe('sanitizeLabel', () => {
  it('strips newlines', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('ok\nlabel')).toBe('oklabel');
  });

  it('strips null bytes', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('ok\x00label')).toBe('oklabel');
  });

  it('truncates to 200 characters', async () => {
    const { sanitizeLabel } = await import('../sender.js');
    expect(sanitizeLabel('a'.repeat(300))).toHaveLength(200);
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

// ─── slothDelaySender (AMQP I/O layer) ───────────────────────────────────────

const mockChannelClose = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn().mockReturnValue(true);
const mockAssertExchange = vi.fn().mockResolvedValue(undefined);
const mockChannel = { assertExchange: mockAssertExchange, publish: mockPublish, close: mockChannelClose };
const mockCreateChannel = vi.fn().mockResolvedValue(mockChannel);
const mockClient = { createChannel: mockCreateChannel };

const mockLogger: SlothLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

describe('slothDelaySender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChannel.mockResolvedValue(mockChannel);
    mockChannelClose.mockResolvedValue(undefined);
  });

  it('publishes to the request exchange with correct routing key and headers', async () => {
    const { slothDelaySender } = await import('../sender.js');
    await slothDelaySender(mockClient as never)({ data: { key: 'test-event' }, delayMinutes: 30, logger: mockLogger, config: testConfig });

    expect(mockAssertExchange).toHaveBeenCalledWith('sloth.direct.exchange.request', 'direct', expect.objectContaining({ durable: true }));
    expect(mockPublish).toHaveBeenCalledWith(
      'sloth.direct.exchange.request',
      'delay',
      expect.any(Buffer),
      expect.objectContaining({
        headers: expect.objectContaining({
          'delay-until': expect.any(Number),
          target: 'amqp://test-service/test.key',
        }),
      }),
    );
    expect(mockChannelClose).toHaveBeenCalled();
  });

  it('closes channel even when publish throws', async () => {
    const { slothDelaySender } = await import('../sender.js');
    mockAssertExchange.mockRejectedValueOnce(new Error('exchange error'));
    await expect(
      slothDelaySender(mockClient as never)({ data: { key: 'test' }, delayMinutes: 5, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('exchange error');
    expect(mockChannelClose).toHaveBeenCalled();
  });

  it('logs warn when channel close fails in finally', async () => {
    const { slothDelaySender } = await import('../sender.js');
    mockChannelClose.mockRejectedValueOnce(new Error('close failed'));
    await slothDelaySender(mockClient as never)({ data: { key: 'test' }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to close'));
  });

  it('throws without opening a channel when data is not JSON-serializable', async () => {
    const { slothDelaySender } = await import('../sender.js');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(
      slothDelaySender(mockClient as never)({ data: circular, delayMinutes: 1, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('not JSON-serializable');
    expect(mockCreateChannel).not.toHaveBeenCalled();
  });

  it('throws without opening a channel when config is invalid', async () => {
    const { slothDelaySender } = await import('../sender.js');
    await expect(
      slothDelaySender(mockClient as never)({ data: { key: 'test' }, delayMinutes: 1, logger: mockLogger, config: { serviceName: 'bad/name', routingKey: 'k' } }),
    ).rejects.toThrow('serviceName');
    expect(mockCreateChannel).not.toHaveBeenCalled();
  });

  it('throws without opening a channel when createChannel fails', async () => {
    const { slothDelaySender } = await import('../sender.js');
    mockCreateChannel.mockRejectedValueOnce(new Error('no channel'));
    await expect(
      slothDelaySender(mockClient as never)({ data: { key: 'test' }, delayMinutes: 1, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('no channel');
    expect(mockChannelClose).not.toHaveBeenCalled();
  });

  it('warns when publish returns false (back-pressure)', async () => {
    const { slothDelaySender } = await import('../sender.js');
    mockPublish.mockReturnValueOnce(false);
    await slothDelaySender(mockClient as never)({ data: { key: 'test' }, delayMinutes: 1, logger: mockLogger, config: testConfig });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('back-pressured'));
  });

  it('suppresses debug and info logs when logLevel is error', async () => {
    const { slothDelaySender } = await import('../sender.js');
    await slothDelaySender(mockClient as never)({ data: { key: 'test' }, delayMinutes: 1, logger: mockLogger, config: testConfig, logLevel: 'error' });
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('uses sanitized logLabel in log output', async () => {
    const { slothDelaySender } = await import('../sender.js');
    await slothDelaySender(mockClient as never)({ data: { x: 1 }, delayMinutes: 1, logger: mockLogger, config: testConfig, logLabel: 'reminder' });
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('reminder'));
  });
});
