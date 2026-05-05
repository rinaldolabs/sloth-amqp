// Integration test: verifies our publish format and consume binding against a real
// RabbitMQ broker. Stand-in for a Sloth server: a tiny consumer/publisher running
// inside the test asserts on what we put on the wire and produces fake delayed
// responses we expect to receive.
//
// Run with: npm run test:integration  (requires Docker)

import amqp, { type ChannelModel, type ConsumeMessage } from 'amqplib';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  setupDelayedMessageListener,
  slothClose,
  slothConnect,
  slothDelaySender,
  slothRequestExchangeName,
  slothResponseExchangeName,
  type SlothConfig,
  type SlothListenerHandle,
  type SlothLogger,
} from '../../src/index.js';

const config: SlothConfig = { serviceName: 'integration-test', routingKey: 'integration.key' };

let rabbit: StartedTestContainer | undefined;
let amqpUrl: string;
const listenerHandles: SlothListenerHandle[] = [];

beforeAll(async () => {
  // Use GenericContainer rather than the @testcontainers/rabbitmq module: the module
  // exposes AMQPS+HTTPS ports (5671, 15671) which RabbitMQ doesn't bind without TLS,
  // and testcontainers' port-readiness check then marks the container as failed.
  // We only need the AMQP port (5672); waiting on the broker's own startup log is
  // the cheapest and most reliable readiness signal.
  // Pin to a specific minor so CI/local runs are deterministic. Renovate's
  // customManagers (renovate.json) tracks this string and opens a PR when a
  // newer rabbitmq tag ships.
  rabbit = await new GenericContainer('rabbitmq:4.1-management')
    .withExposedPorts(5672, 15672)
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .withStartupTimeout(120_000)
    .start();
  const host = rabbit.getHost();
  const port = rabbit.getMappedPort(5672);
  amqpUrl = `amqp://guest:guest@${host}:${String(port)}`;
}, 180_000);

afterAll(async () => {
  // Tear down in reverse order: consumers first (so they don't try to talk to a
  // closing broker), then the broker. Each step is best-effort and guarded so a
  // failure in beforeAll doesn't mask itself with a follow-on TypeError here.
  for (const handle of listenerHandles) {
    await handle.close().catch(() => {
      // ignore — best effort
    });
  }
  if (rabbit) {
    await rabbit.stop();
  }
});

describe('publish path: slothDelaySender produces the wire format Sloth expects', () => {
  it('publishes to the request exchange with delay routing key, target header, and delay-until', async () => {
    // All AMQP handles are tracked so we close them in finally, even if an
    // assertion throws — open AMQP sockets keep vitest from exiting cleanly.
    const consumerConn = await amqp.connect(amqpUrl);
    let client: ChannelModel | undefined;
    try {
      const consumerCh = await consumerConn.createChannel();
      await consumerCh.assertExchange(slothRequestExchangeName, 'direct', { durable: true });
      const { queue: probeQueue } = await consumerCh.assertQueue('', {
        exclusive: true,
        autoDelete: true,
      });
      await consumerCh.bindQueue(probeQueue, slothRequestExchangeName, 'delay');

      const captured = new Promise<ConsumeMessage>((resolve) => {
        void consumerCh.consume(
          probeQueue,
          (msg) => {
            if (msg) resolve(msg);
          },
          { noAck: true },
        );
      });

      client = await slothConnect(amqpUrl);
      const send = slothDelaySender(client);
      const before = Math.floor(Date.now() / 1000);
      await send({
        data: { kind: 'reminder', userId: 'u-1' },
        delayMinutes: 5,
        logger: silentLogger,
        config,
      });

      // Assert: the message arrived with the exact wire shape Sloth's amqp.go parses.
      const msg = await captured;
      const headers = msg.properties.headers ?? {};

      expect(msg.fields.exchange).toBe(slothRequestExchangeName);
      expect(msg.fields.routingKey).toBe('delay');

      const target = headers['target'];
      expect(target).toBe('amqp://integration-test/integration.key');
      // Sanity: matches the URL shape Sloth's url.Parse + Path[1:] expects (no trailing /).
      const parsed = new URL(String(target));
      expect(parsed.host).toBe('integration-test');
      expect(parsed.pathname.replace(/^\//, '')).toBe('integration.key');

      const delayUntil = headers['delay-until'];
      expect(typeof delayUntil).toBe('number');
      expect(delayUntil).toBeGreaterThanOrEqual(before + 5 * 60 - 1);
      expect(delayUntil).toBeLessThanOrEqual(before + 5 * 60 + 5);

      const body = JSON.parse(msg.content.toString()) as Record<string, unknown>;
      expect(body).toEqual({ kind: 'reminder', userId: 'u-1' });
    } finally {
      if (client) await slothClose(client).catch(() => {});
      await consumerConn.close().catch(() => {});
    }
  });
});

describe('consume path: setupDelayedMessageListener consumes responses Sloth produces', () => {
  it('receives a message published to the response exchange with the matching service header', async () => {
    // Await the listener setup before publishing so the queue and binding exist —
    // no fixed sleeps, no races. setupDelayedMessageListener resolves only after
    // assertExchange / assertQueue / bindQueue / consume have all completed.
    let resolveReceived!: (msg: ConsumeMessage) => void;
    const received = new Promise<ConsumeMessage>((resolve) => {
      resolveReceived = resolve;
    });

    const handle = await setupDelayedMessageListener({
      amqpUrl,
      config,
      logger: silentLogger,
      onMessage: (message) => {
        resolveReceived(message);
        return Promise.resolve();
      },
    });
    listenerHandles.push(handle);

    // Publish a fake "delayed response" the way the Sloth sink would.
    // Wrapped in finally so a failing assertion doesn't leak the AMQP connection.
    const publisherConn = await amqp.connect(amqpUrl);
    try {
      const publisherCh = await publisherConn.createChannel();
      await publisherCh.assertExchange(slothResponseExchangeName, 'headers', { durable: true });
      const ok = publisherCh.publish(
        slothResponseExchangeName,
        config.routingKey,
        Buffer.from(JSON.stringify({ delivered: true, n: 42 })),
        { headers: { service: config.serviceName }, persistent: true },
      );
      expect(ok).toBe(true);

      const msg = await received;
      expect(msg.fields.routingKey).toBe(config.routingKey);
      const payload = JSON.parse(msg.content.toString()) as Record<string, unknown>;
      expect(payload).toEqual({ delivered: true, n: 42 });
    } finally {
      await publisherConn.close().catch(() => {});
    }
  });
});

const silentLogger: SlothLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};
