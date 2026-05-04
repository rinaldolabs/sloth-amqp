import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';
import type { SlothConfig } from '../utils.js';

const testConfig: SlothConfig = { serviceName: 'test-service', routingKey: 'test.key' };

const mockChannelClose = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn().mockReturnValue(true);
const mockAssertExchange = vi.fn().mockResolvedValue(undefined);
const mockChannel = {
  assertExchange: mockAssertExchange,
  publish: mockPublish,
  close: mockChannelClose,
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

describe('slothDelaySender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChannel.mockResolvedValue(mockChannel);
    mockChannelClose.mockResolvedValue(undefined);
  });

  it('sends a delayed message with correct headers', async () => {
    const { slothDelaySender } = await import('../sender.js');
    const send = slothDelaySender(mockClient as never);

    await send({
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
          'delay-until': expect.any(Number),
          target: 'amqp://test-service/test.key/',
        }),
      }),
    );
    expect(mockChannelClose).toHaveBeenCalled();
  });

  it('closes channel even when publish throws', async () => {
    const { slothDelaySender } = await import('../sender.js');
    mockAssertExchange.mockRejectedValueOnce(new Error('exchange error'));
    const send = slothDelaySender(mockClient as never);

    await expect(
      send({ data: { key: 'test' }, delayMinutes: 5, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('exchange error');

    expect(mockChannelClose).toHaveBeenCalled();
  });

  it('logs warn when channel close fails in finally', async () => {
    const { slothDelaySender } = await import('../sender.js');
    mockChannelClose.mockRejectedValueOnce(new Error('close failed'));
    const send = slothDelaySender(mockClient as never);

    await send({ data: { key: 'test' }, delayMinutes: 1, logger: mockLogger, config: testConfig });

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to close'));
  });

  it('throws if delayMinutes is zero', async () => {
    const { slothDelaySender } = await import('../sender.js');
    const send = slothDelaySender(mockClient as never);

    await expect(
      send({ data: { key: 'test' }, delayMinutes: 0, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('delayMinutes must be a positive number');
  });

  it('throws if delayMinutes is negative', async () => {
    const { slothDelaySender } = await import('../sender.js');
    const send = slothDelaySender(mockClient as never);

    await expect(
      send({ data: { key: 'test' }, delayMinutes: -5, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('delayMinutes must be a positive number');
  });

  it('sets delay-until as unix seconds', async () => {
    const { slothDelaySender } = await import('../sender.js');
    const before = Math.floor(Date.now() / 1000);
    const send = slothDelaySender(mockClient as never);

    await send({ data: { key: 'test' }, delayMinutes: 60, logger: mockLogger, config: testConfig });

    const headers = mockPublish.mock.calls[0]?.[3]?.headers as Record<string, number>;
    const delayUntil = headers['delay-until'];
    expect(delayUntil).toBeGreaterThanOrEqual(before + 3600);
    expect(delayUntil).toBeLessThan(before + 3601);
  });

  it('throws without closing channel when createChannel fails', async () => {
    const { slothDelaySender } = await import('../sender.js');
    mockCreateChannel.mockRejectedValueOnce(new Error('no channel'));
    const send = slothDelaySender(mockClient as never);

    await expect(
      send({ data: { key: 'test' }, delayMinutes: 1, logger: mockLogger, config: testConfig }),
    ).rejects.toThrow('no channel');

    expect(mockChannelClose).not.toHaveBeenCalled();
  });
});
