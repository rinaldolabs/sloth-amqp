import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';
import type { SlothConfig } from '../utils.js';

const testConfig: SlothConfig = { serviceName: 'test-service', routingKey: 'test.key' };

const mockChannelClose = vi.fn().mockResolvedValue(undefined);
const mockConnectionClose = vi.fn().mockResolvedValue(undefined);
let channelErrorHandler: ((err: Error) => void) | null = null;
let channelCloseHandler: (() => void) | null = null;

const mockChannel = {
  on: vi.fn((event: string, handler: unknown) => {
    if (event === 'error') channelErrorHandler = handler as (err: Error) => void;
    if (event === 'close') channelCloseHandler = handler as () => void;
  }),
  assertExchange: vi.fn().mockResolvedValue(undefined),
  assertQueue: vi.fn().mockResolvedValue(undefined),
  bindQueue: vi.fn().mockResolvedValue(undefined),
  consume: vi.fn().mockResolvedValue(undefined),
  close: mockChannelClose,
};
const mockCreateChannel = vi.fn().mockResolvedValue(mockChannel);
const mockConnection = { createChannel: mockCreateChannel, close: mockConnectionClose };
const mockConnect = vi.fn().mockResolvedValue(mockConnection);

vi.mock('amqplib', () => ({ default: { connect: mockConnect } }));

const mockLogger: SlothLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

describe('setupDelayedMessageListener', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    channelErrorHandler = null;
    channelCloseHandler = null;
    mockConnect.mockResolvedValue(mockConnection);
    mockCreateChannel.mockResolvedValue(mockChannel);
    mockChannelClose.mockResolvedValue(undefined);
    mockConnectionClose.mockResolvedValue(undefined);

    const mod = await import('../listener.js');
    await mod.cleanup();
  });

  it('sets up exchange, queue, binding, and consumer', async () => {
    const { setupDelayedMessageListener } = await import('../listener.js');
    const onMessage = vi.fn();

    await setupDelayedMessageListener({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      'sloth.headers.exchange.response',
      'headers',
      expect.objectContaining({ durable: true }),
    );
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'sloth.headers.exchange.response.queue.test-service',
      expect.objectContaining({ durable: true }),
    );
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      'sloth.headers.exchange.response.queue.test-service',
      'sloth.headers.exchange.response',
      'test.key',
      expect.objectContaining({ service: 'test-service' }),
    );
    expect(mockChannel.consume).toHaveBeenCalled();
  });

  it('calls onMessage when a message arrives', async () => {
    const { setupDelayedMessageListener } = await import('../listener.js');
    const onMessage = vi.fn().mockResolvedValue(undefined);

    await setupDelayedMessageListener({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0]?.[1] as (msg: unknown) => void;
    const fakeMsg = { content: Buffer.from('{}') };
    consumeCallback(fakeMsg);

    expect(onMessage).toHaveBeenCalledWith(fakeMsg);
  });

  it('does not call onMessage when message is null', async () => {
    const { setupDelayedMessageListener } = await import('../listener.js');
    const onMessage = vi.fn();

    await setupDelayedMessageListener({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0]?.[1] as (msg: unknown) => void;
    consumeCallback(null);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('logs channel errors via error event', async () => {
    const { setupDelayedMessageListener } = await import('../listener.js');
    await setupDelayedMessageListener({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    expect(channelErrorHandler).not.toBeNull();
    channelErrorHandler!(new Error('channel broke'));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('channel error'));
  });

  it('nulls channel on close event', async () => {
    const { setupDelayedMessageListener } = await import('../listener.js');
    await setupDelayedMessageListener({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    expect(channelCloseHandler).not.toBeNull();
    channelCloseHandler!();
    expect(mockLogger.warn).toHaveBeenCalledWith('AMQP channel closed');
  });

  it('cleans up and rethrows on setup error', async () => {
    const { setupDelayedMessageListener } = await import('../listener.js');
    mockCreateChannel.mockRejectedValueOnce(new Error('channel error'));

    await expect(
      setupDelayedMessageListener({
        amqpUrl: 'amqp://localhost',
        config: testConfig,
        onMessage: vi.fn(),
        logger: mockLogger,
      }),
    ).rejects.toThrow('channel error');

    expect(mockConnectionClose).toHaveBeenCalled();
  });

  it('uses NoOpLogger when no logger provided', async () => {
    const { setupDelayedMessageListener } = await import('../listener.js');
    await expect(
      setupDelayedMessageListener({
        amqpUrl: 'amqp://localhost',
        config: testConfig,
        onMessage: vi.fn(),
      }),
    ).resolves.not.toThrow();
  });
});

describe('cleanup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockChannelClose.mockResolvedValue(undefined);
    mockConnectionClose.mockResolvedValue(undefined);
    const mod = await import('../listener.js');
    await mod.cleanup();
  });

  it('is safe to call multiple times', async () => {
    const { cleanup } = await import('../listener.js');
    await cleanup();
    await cleanup();
  });

  it('closes channel and connection', async () => {
    const { setupDelayedMessageListener, cleanup } = await import('../listener.js');
    mockConnect.mockResolvedValueOnce(mockConnection);

    await setupDelayedMessageListener({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
    });
    await cleanup();

    expect(mockChannelClose).toHaveBeenCalled();
    expect(mockConnectionClose).toHaveBeenCalled();
  });

  it('swallows errors during cleanup', async () => {
    const { setupDelayedMessageListener, cleanup } = await import('../listener.js');
    mockConnect.mockResolvedValueOnce(mockConnection);
    mockChannelClose.mockRejectedValueOnce(new Error('close error'));

    await setupDelayedMessageListener({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
    });
    await expect(cleanup()).resolves.not.toThrow();
  });
});
