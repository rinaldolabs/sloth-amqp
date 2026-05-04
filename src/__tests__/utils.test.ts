import { describe, expect, it } from 'vitest';
import {
  assertSafeSlothConfig,
  defaultListenerQueueExpiresMs,
  getSlothQueueName,
  getSlothTarget,
  slothRequestExchangeName,
  slothResponseExchangeName,
} from '../utils.js';

describe('protocol constants', () => {
  it('slothRequestExchangeName', () => {
    expect(slothRequestExchangeName).toBe('sloth.direct.exchange.request');
  });

  it('slothResponseExchangeName', () => {
    expect(slothResponseExchangeName).toBe('sloth.headers.exchange.response');
  });
});

describe('getSlothQueueName', () => {
  it('builds queue name from serviceName', () => {
    expect(getSlothQueueName({ serviceName: 'my-service', routingKey: 'my.key' })).toBe(
      'sloth.headers.exchange.response.queue.my-service',
    );
  });
});

describe('getSlothTarget', () => {
  it('builds target header from serviceName and routingKey', () => {
    expect(getSlothTarget({ serviceName: 'my-service', routingKey: 'my.key' })).toBe(
      'amqp://my-service/my.key/',
    );
  });
});

describe('defaultListenerQueueExpiresMs', () => {
  it('is 5 days in ms', () => {
    expect(defaultListenerQueueExpiresMs).toBe(5 * 24 * 60 * 60 * 1000);
  });
});

describe('assertSafeSlothConfig', () => {
  it('accepts valid identifiers', () => {
    expect(() =>
      assertSafeSlothConfig({ serviceName: 'svc-1.test_x', routingKey: 'a.b-c_d' }),
    ).not.toThrow();
  });

  it('rejects empty serviceName', () => {
    expect(() => assertSafeSlothConfig({ serviceName: '', routingKey: 'k' })).toThrow(
      'serviceName',
    );
  });

  it('rejects empty routingKey', () => {
    expect(() => assertSafeSlothConfig({ serviceName: 's', routingKey: '' })).toThrow(
      'routingKey',
    );
  });

  it('rejects path traversal in serviceName', () => {
    expect(() => assertSafeSlothConfig({ serviceName: '../evil', routingKey: 'k' })).toThrow(
      'serviceName',
    );
  });

  it('rejects slash in routingKey', () => {
    expect(() => assertSafeSlothConfig({ serviceName: 's', routingKey: 'a/b' })).toThrow(
      'routingKey',
    );
  });

  it('rejects whitespace', () => {
    expect(() => assertSafeSlothConfig({ serviceName: 'a b', routingKey: 'k' })).toThrow();
  });
});

describe('getSlothQueueName / getSlothTarget validation', () => {
  it('getSlothQueueName throws on invalid config', () => {
    expect(() => getSlothQueueName({ serviceName: '', routingKey: 'k' })).toThrow();
  });
  it('getSlothTarget throws on invalid config', () => {
    expect(() => getSlothTarget({ serviceName: 's', routingKey: '' })).toThrow();
  });
});
