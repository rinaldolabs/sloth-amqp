import { describe, expect, it } from 'vitest';
import {
  assertSafeSlothConfig,
  defaultListenerPrefetch,
  defaultListenerQueueExpiresMs,
  getSlothQueueName,
  getSlothTarget,
  slothClientProperties,
  slothDelayRoutingKey,
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

  it('slothDelayRoutingKey', () => {
    expect(slothDelayRoutingKey).toBe('delay');
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
      'amqp://my-service/my.key',
    );
  });
});

describe('defaultListenerQueueExpiresMs', () => {
  it('is 5 days in ms', () => {
    expect(defaultListenerQueueExpiresMs).toBe(5 * 24 * 60 * 60 * 1000);
  });
});

describe('defaultListenerPrefetch', () => {
  it('is 20', () => {
    expect(defaultListenerPrefetch).toBe(20);
  });
});

describe('slothClientProperties', () => {
  it('defaults connection_name to <serviceName>:sloth-amqp@<hostname>', () => {
    const props = slothClientProperties({ serviceName: 'my-service' });
    expect(props['connection_name']).toMatch(/^my-service:sloth-amqp@.+/);
  });

  it('uses an explicit connectionName verbatim', () => {
    expect(slothClientProperties({ serviceName: 'my-service', connectionName: 'pinned' })).toEqual({
      connection_name: 'pinned',
    });
  });

  it('rejects an unsafe serviceName', () => {
    expect(() => slothClientProperties({ serviceName: '../evil' })).toThrow('serviceName');
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
    expect(() => assertSafeSlothConfig({ serviceName: 's', routingKey: '' })).toThrow('routingKey');
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

  it('accepts identifiers up to 200 chars and rejects longer ones', () => {
    // 200 keeps every derived AMQP name (38-char queue prefix + serviceName)
    // under the protocol's 255-byte short-string limit.
    const max = 'a'.repeat(200);
    expect(() => assertSafeSlothConfig({ serviceName: max, routingKey: max })).not.toThrow();
    const over = 'a'.repeat(201);
    expect(() => assertSafeSlothConfig({ serviceName: over, routingKey: 'k' })).toThrow(
      'max 200 chars',
    );
    expect(() => assertSafeSlothConfig({ serviceName: 's', routingKey: over })).toThrow(
      'routingKey',
    );
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
