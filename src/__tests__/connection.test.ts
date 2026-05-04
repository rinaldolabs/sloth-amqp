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
});

describe('slothClose', () => {
  it('calls close on the client', async () => {
    const { slothClose } = await import('../connection.js');
    await slothClose(mockClient as never);
    expect(mockClose).toHaveBeenCalled();
  });
});
