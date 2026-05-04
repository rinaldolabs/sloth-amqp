import { describe, expect, it } from 'vitest';
import {
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
