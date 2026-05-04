import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlothLogger } from '../logger.js';
import type { SlothConfig } from '../utils.js';

const testConfig: SlothConfig = { serviceName: 'test-service', routingKey: 'test.key' };

const mockChannelClose = vi.fn().mockResolvedValue(undefined);
const mockChannelCancel = vi.fn().mockResolvedValue(undefined);
const mockChannelAck = vi.fn();
const mockChannelNack = vi.fn();
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
  consume: vi.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
  cancel: mockChannelCancel,
  ack: mockChannelAck,
  nack: mockChannelNack,
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

const setup = async () => {
  const { setupDelayedMessageListener } = await import('../listener.js');
  return setupDelayedMessageListener;
};

describe('setupDelayedMessageListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelErrorHandler = null;
    channelCloseHandler = null;
    mockConnect.mockResolvedValue(mockConnection);
    mockCreateChannel.mockResolvedValue(mockChannel);
    mockChannelClose.mockResolvedValue(undefined);
    mockChannelCancel.mockResolvedValue(undefined);
    mockConnectionClose.mockResolvedValue(undefined);
    mockChannel.consume.mockResolvedValue({ consumerTag: 'tag-1' });
  });

  it('sets up exchange, queue, binding, and consumer with manual ack', async () => {
    const setupFn = await setup();
    const onMessage = vi.fn();

    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    expect(handle.consumerTag).toBe('tag-1');
    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      'sloth.headers.exchange.response',
      'headers',
      expect.objectContaining({ durable: true }),
    );
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'sloth.headers.exchange.response.queue.test-service',
      expect.objectContaining({ durable: true, expires: 5 * 24 * 60 * 60 * 1000 }),
    );
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      'sloth.headers.exchange.response.queue.test-service',
      'sloth.headers.exchange.response',
      'test.key',
      expect.objectContaining({ service: 'test-service' }),
    );
    expect(mockChannel.consume).toHaveBeenCalledWith(
      'sloth.headers.exchange.response.queue.test-service',
      expect.any(Function),
      { noAck: false },
    );

    await handle.close();
  });

  it('uses custom queueExpiresMs when provided', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
      queueExpiresMs: 60000,
    });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expires: 60000 }),
    );
    await handle.close();
  });

  it('rejects empty amqpUrl', async () => {
    const setupFn = await setup();
    await expect(
      setupFn({ amqpUrl: '', config: testConfig, onMessage: vi.fn(), logger: mockLogger }),
    ).rejects.toThrow('amqpUrl');
  });

  it('rejects invalid queueExpiresMs', async () => {
    const setupFn = await setup();
    await expect(
      setupFn({
        amqpUrl: 'amqp://localhost',
        config: testConfig,
        onMessage: vi.fn(),
        logger: mockLogger,
        queueExpiresMs: 0,
      }),
    ).rejects.toThrow('queueExpiresMs');
  });

  it('rejects invalid serviceName', async () => {
    const setupFn = await setup();
    await expect(
      setupFn({
        amqpUrl: 'amqp://localhost',
        config: { serviceName: '', routingKey: 'k' },
        onMessage: vi.fn(),
        logger: mockLogger,
      }),
    ).rejects.toThrow('serviceName');
  });

  it('acks message when onMessage resolves', async () => {
    const setupFn = await setup();
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0]?.[1] as (msg: unknown) => void;
    const fakeMsg = { content: Buffer.from('{}') };
    consumeCallback(fakeMsg);
    await new Promise((r) => setImmediate(r));

    expect(onMessage).toHaveBeenCalledWith(fakeMsg);
    expect(mockChannelAck).toHaveBeenCalledWith(fakeMsg);
    expect(mockChannelNack).not.toHaveBeenCalled();
    await handle.close();
  });

  it('nacks (no requeue) when onMessage rejects and logs error', async () => {
    const setupFn = await setup();
    const onMessage = vi.fn().mockRejectedValue(new Error('boom'));
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0]?.[1] as (msg: unknown) => void;
    const fakeMsg = { content: Buffer.from('{}') };
    consumeCallback(fakeMsg);
    await new Promise((r) => setImmediate(r));

    expect(mockChannelNack).toHaveBeenCalledWith(fakeMsg, false, false);
    expect(mockChannelAck).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    await handle.close();
  });

  it('handles non-Error rejection from onMessage', async () => {
    const setupFn = await setup();
    const onMessage = vi.fn().mockRejectedValue('string-failure');
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0]?.[1] as (msg: unknown) => void;
    consumeCallback({ content: Buffer.from('{}') });
    await new Promise((r) => setImmediate(r));

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('string-failure'));
    await handle.close();
  });

  it('does not call onMessage when message is null', async () => {
    const setupFn = await setup();
    const onMessage = vi.fn();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage,
      logger: mockLogger,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0]?.[1] as (msg: unknown) => void;
    consumeCallback(null);

    expect(onMessage).not.toHaveBeenCalled();
    await handle.close();
  });

  it('logs channel errors via error event', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    expect(channelErrorHandler).not.toBeNull();
    channelErrorHandler!(new Error('channel broke'));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('channel error'));
    await handle.close();
  });

  it('logs warn on channel close event', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    expect(channelCloseHandler).not.toBeNull();
    channelCloseHandler!();
    expect(mockLogger.warn).toHaveBeenCalledWith('AMQP channel closed');
    await handle.close();
  });

  it('cleans up and rethrows on setup error', async () => {
    const setupFn = await setup();
    mockCreateChannel.mockRejectedValueOnce(new Error('channel error'));

    await expect(
      setupFn({
        amqpUrl: 'amqp://localhost',
        config: testConfig,
        onMessage: vi.fn(),
        logger: mockLogger,
      }),
    ).rejects.toThrow('channel error');

    expect(mockConnectionClose).toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('channel error'));
  });

  it('uses NoOpLogger when no logger provided', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
    });
    await handle.close();
  });
});

describe('SlothListenerHandle.close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelClose.mockResolvedValue(undefined);
    mockChannelCancel.mockResolvedValue(undefined);
    mockConnectionClose.mockResolvedValue(undefined);
    mockChannel.consume.mockResolvedValue({ consumerTag: 'tag-1' });
    mockCreateChannel.mockResolvedValue(mockChannel);
    mockConnect.mockResolvedValue(mockConnection);
  });

  it('cancels consumer, closes channel and connection', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    await handle.close();

    expect(mockChannelCancel).toHaveBeenCalledWith('tag-1');
    expect(mockChannelClose).toHaveBeenCalled();
    expect(mockConnectionClose).toHaveBeenCalled();
  });

  it('is safe to call multiple times', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    await handle.close();
    await expect(handle.close()).resolves.not.toThrow();
  });

  it('logs error when consumer cancel fails', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    mockChannelCancel.mockRejectedValueOnce(new Error('cancel failed'));
    await handle.close();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('cancel failed'));
  });

  it('logs error when channel.close fails', async () => {
    const setupFn = await setup();
    const handle = await setupFn({
      amqpUrl: 'amqp://localhost',
      config: testConfig,
      onMessage: vi.fn(),
      logger: mockLogger,
    });

    mockChannelClose.mockRejectedValueOnce(new Error('close failed'));
    await handle.close();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('close failed'));
  });
});
