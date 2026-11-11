// Integration test: verifies our publish format and consume binding against a real
// RabbitMQ broker. Stand-in for a Sloth server: a tiny consumer/publisher running
// inside the test asserts on what we put on the wire and produces fake delayed
// responses we expect to receive.
//
// Run with: npm run test:integration  (requires Docker)
// CI runs one leg per RABBITMQ_VERSION x RABBITMQ_VHOST_DEFAULT (integration.yml).

import { randomBytes } from 'node:crypto';
import amqp, { type ChannelModel, type ConsumeMessage } from 'amqplib';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDelaySender,
  defaultListenerQueueExpiresMs,
  getSlothQueueName,
  setupDelayedMessageListener,
  slothClose,
  slothConnect,
  slothRequestExchangeName,
  slothResponseExchangeName,
  type SlothConfig,
  type SlothListenerClosedReason,
  type SlothListenerHandle,
  type SlothLogger,
} from '../../src/index.js';

type VhostDefault = 'classic' | 'quorum';
type TimeoutOutcome = 'channel-closed' | 'none' | 'consumer-cancelled';

interface Leg {
  version: string;
  vhostDefault: VhostDefault;
  timeoutExpect: TimeoutOutcome;
}

const isBefore43 = (version: string): boolean => {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < 4 || (major === 4 && minor < 3);
};

const expectedTimeoutOutcome = (version: string, vhostDefault: VhostDefault): TimeoutOutcome => {
  if (isBefore43(version)) return 'channel-closed';
  return vhostDefault === 'quorum' ? 'consumer-cancelled' : 'none';
};

// A CI leg must name its broker explicitly; a silent fallback would test the
// wrong configuration under a green check.
const resolveLeg = (): Leg => {
  const inCi = process.env['CI'] === 'true';
  const version = process.env['RABBITMQ_VERSION'] ?? (inCi ? undefined : '4.4.0');
  if (version === undefined) throw new Error('RABBITMQ_VERSION must be set in CI');
  const vhostDefault = process.env['RABBITMQ_VHOST_DEFAULT'] ?? (inCi ? undefined : 'classic');
  if (vhostDefault !== 'classic' && vhostDefault !== 'quorum') {
    throw new Error('RABBITMQ_VHOST_DEFAULT must be classic or quorum');
  }
  const timeoutExpect = expectedTimeoutOutcome(version, vhostDefault);
  const declared = process.env['TIMEOUT_EXPECT'] ?? (inCi ? undefined : timeoutExpect);
  if (declared !== timeoutExpect) {
    throw new Error(
      `TIMEOUT_EXPECT=${String(declared)} does not match ${timeoutExpect} for ${version}/${vhostDefault}`,
    );
  }
  return { version, vhostDefault, timeoutExpect };
};

const loopbackHosts: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);
const consumerTimeoutMs = 60_000;

const config: SlothConfig = { serviceName: 'integration-test', routingKey: 'integration.key' };

let rabbit: StartedTestContainer | undefined;
let leg: Leg;
let amqpUrl: string;
let amqpBaseUrl: string;
let brokerUser: string;
let vhost = '/';
let mgmtBase: string;
let mgmtAuth: string;
const listenerHandles: SlothListenerHandle[] = [];

interface MgmtResponse {
  status: number;
  body: unknown;
}

const mgmt = async (method: string, path: string, payload?: unknown): Promise<MgmtResponse> => {
  const response = await fetch(`${mgmtBase}${path}`, {
    method,
    headers: { authorization: mgmtAuth, 'content-type': 'application/json' },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const vhostPath = (): string => encodeURIComponent(vhost);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
  describeWait: () => string,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${describeWait()}`);
};

const consumeWithGlobalQos = async (client: ChannelModel): Promise<void> => {
  const queue = `integration.global-qos.${randomBytes(4).toString('hex')}`;
  const channel = await client.createChannel();
  channel.on('error', () => {
    // the connection error carries the code
  });
  await channel.prefetch(1, true);
  await channel.assertQueue(queue, { durable: true, expires: defaultListenerQueueExpiresMs });
  await channel.consume(queue, () => {}, { noAck: false });
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

beforeAll(async () => {
  leg = resolveLeg();
  const user = `sloth-${randomBytes(6).toString('hex')}`;
  brokerUser = user;
  const password = randomBytes(24).toString('hex');

  // GenericContainer rather than @testcontainers/rabbitmq: that module exposes
  // TLS ports the broker never binds, which fails its port-readiness check.
  // The default user is generated per run, so the image creates no guest user.
  rabbit = await new GenericContainer(`rabbitmq:${leg.version}-management`)
    .withEnvironment({ RABBITMQ_DEFAULT_USER: user, RABBITMQ_DEFAULT_PASS: password })
    .withExposedPorts(5672, 15672)
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .withStartupTimeout(120_000)
    .start();

  const host = rabbit.getHost();
  if (!loopbackHosts.has(host)) {
    throw new Error(`refusing to test against non-loopback Docker host ${host}`);
  }
  mgmtBase = `http://${host}:${String(rabbit.getMappedPort(15672))}/api`;
  mgmtAuth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  if (leg.vhostDefault === 'quorum') {
    vhost = 'sloth-q';
    const created = await mgmt('PUT', `/vhosts/${vhostPath()}`, { default_queue_type: 'quorum' });
    const granted = await mgmt('PUT', `/permissions/${vhostPath()}/${user}`, {
      configure: '.*',
      write: '.*',
      read: '.*',
    });
    if (created.status >= 300 || granted.status >= 300) {
      throw new Error(
        `quorum vhost setup failed (${String(created.status)}/${String(granted.status)})`,
      );
    }
  }
  amqpBaseUrl = `amqp://${user}:${password}@${host}:${String(rabbit.getMappedPort(5672))}`;
  amqpUrl = `${amqpBaseUrl}/${vhostPath()}`;
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

describe('broker leg', () => {
  it('a. the broker reports the version this leg was started for', async () => {
    const client = await amqp.connect(amqpUrl);
    try {
      const reported = client.connection.serverProperties.version;
      console.info(`leg version=${reported} vhost=${leg.vhostDefault}`);
      expect(reported).toBe(leg.version);
    } finally {
      await client.close();
    }
  });

  it('b. the listener queue gets the vhost default type', async () => {
    const typeConfig: SlothConfig = {
      serviceName: 'integration-type',
      routingKey: 'integration.type.key',
    };
    const handle = await setupDelayedMessageListener({
      amqpUrl,
      config: typeConfig,
      logger: silentLogger,
      onMessage: () => Promise.resolve(),
    });
    try {
      const queue = await mgmt(
        'GET',
        `/queues/${vhostPath()}/${encodeURIComponent(getSlothQueueName(typeConfig))}`,
      );
      expect(queue.status).toBe(200);
      expect(Reflect.get(Object(queue.body), 'type')).toBe(leg.vhostDefault);
    } finally {
      await handle.close();
    }
  });

  it('c. global QoS: 540 on a quorum queue before 4.3, rewritten to per-consumer from 4.3', async () => {
    // Characterises the broker, not this library (which never asks for global
    // QoS). 540 is connection-level, so this runs on its own connection.
    const client = await amqp.connect(amqpUrl);
    const connectionError = new Promise<unknown>((resolve) => {
      client.on('error', (err: unknown) => {
        resolve(Reflect.get(Object(err), 'code'));
      });
    });
    const consumed = await consumeWithGlobalQos(client).then(
      () => true,
      () => false,
    );
    const code = await Promise.race([connectionError, sleep(1_500).then(() => undefined)]);
    console.info(`test-c-outcome=${consumed ? 'consumed' : `connection-error-${String(code)}`}`);
    if (leg.vhostDefault === 'quorum' && isBefore43(leg.version)) {
      expect(consumed).toBe(false);
      expect(code).toBe(540);
    } else {
      expect(consumed).toBe(true);
      expect(code).toBeUndefined();
      await client.close();
    }
  });
});

describe('publish path: createDelaySender produces the wire format Sloth expects', () => {
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
      const { send } = createDelaySender(client);
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

      // Durability parity with goamqp's publishMessage: persistent delivery
      // (a broker restart before Sloth consumes must not drop the request)
      // and an explicit JSON content type.
      expect(msg.properties.deliveryMode).toBe(2);
      expect(msg.properties.contentType).toBe('application/json');
      expect(typeof msg.properties.messageId).toBe('string');

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

describe('publish path: mandatory', () => {
  it('e. an unroutable request resolves by default and rejects with mandatory: true', async () => {
    const client = await slothConnect(amqpUrl);
    const send = (mandatory?: boolean): Promise<void> =>
      createDelaySender(client, mandatory === undefined ? {} : { mandatory }).send({
        data: { kind: 'mandatory-check' },
        delayMinutes: 1,
        logger: silentLogger,
        config,
      });
    try {
      // The publish-path test bound an exclusive probe queue to 'delay'. Until
      // its binding is gone, 4.2 nacks a publish routed to the deleted queue.
      await waitFor(
        async () => {
          const { status, body } = await mgmt(
            'GET',
            `/exchanges/${vhostPath()}/${slothRequestExchangeName}/bindings/source`,
          );
          return status === 404 || (Array.isArray(body) && body.length === 0);
        },
        10_000,
        () => `no queue bound to ${slothRequestExchangeName}`,
      );
      await expect(send()).resolves.toBeUndefined();
      await expect(send(false)).resolves.toBeUndefined();
      await expect(send(true)).rejects.toThrow('unroutable');

      const channel = await client.createChannel();
      const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
      await channel.bindQueue(queue, slothRequestExchangeName, 'delay');
      await expect(send(true)).resolves.toBeUndefined();
      await expect(send()).resolves.toBeUndefined();
    } finally {
      await slothClose(client).catch(() => {});
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

describe('consume path: the headers binding actually discriminates by service', () => {
  it('delivers only messages whose service header matches; wrong or absent headers are dropped', async () => {
    // A broken binding that matched everything (e.g. empty binding args under
    // x-match:all) would pass the positive test above — only a negative case
    // proves service isolation on the shared response exchange.
    const isolationConfig: SlothConfig = {
      serviceName: 'integration-isolation',
      routingKey: 'integration.isolation.key',
    };
    const received: string[] = [];
    let resolveMatched!: () => void;
    const matched = new Promise<void>((resolve) => {
      resolveMatched = resolve;
    });

    const handle = await setupDelayedMessageListener({
      amqpUrl,
      config: isolationConfig,
      logger: silentLogger,
      onMessage: (message) => {
        const payload = JSON.parse(message.content.toString()) as { id: string };
        received.push(payload.id);
        if (payload.id === 'match') resolveMatched();
        return Promise.resolve();
      },
    });
    listenerHandles.push(handle);

    const publisherConn = await amqp.connect(amqpUrl);
    try {
      const publisherCh = await publisherConn.createChannel();
      await publisherCh.assertExchange(slothResponseExchangeName, 'headers', { durable: true });
      const publish = (id: string, headers: Record<string, unknown>): void => {
        publisherCh.publish(
          slothResponseExchangeName,
          isolationConfig.routingKey,
          Buffer.from(JSON.stringify({ id })),
          { headers, persistent: true },
        );
      };
      // Mismatched and headerless messages first, the matching one last — if
      // any of the first two were wrongly delivered, they would arrive before
      // 'match' and break the assertion below. No sleeps needed.
      publish('wrong-service', { service: 'some-other-service' });
      publish('no-header', {});
      publish('match', { service: isolationConfig.serviceName });

      await matched;
      expect(received).toEqual(['match']);
    } finally {
      await publisherConn.close().catch(() => {});
    }
  });
});

describe('nack path: a failing handler drops the message (requeue=false)', () => {
  it('nacks without redelivery and keeps consuming subsequent messages', async () => {
    const nackConfig: SlothConfig = {
      serviceName: 'integration-nack',
      routingKey: 'integration.nack.key',
    };
    const seen: string[] = [];
    let resolveSentinel!: () => void;
    const sentinelArrived = new Promise<void>((resolve) => {
      resolveSentinel = resolve;
    });

    const handle = await setupDelayedMessageListener({
      amqpUrl,
      config: nackConfig,
      logger: silentLogger,
      onMessage: (message) => {
        const payload = JSON.parse(message.content.toString()) as { id: string };
        seen.push(payload.id);
        if (payload.id === 'poison') {
          return Promise.reject(new Error('handler failure'));
        }
        resolveSentinel();
        return Promise.resolve();
      },
    });
    listenerHandles.push(handle);

    const publisherConn = await amqp.connect(amqpUrl);
    try {
      const publisherCh = await publisherConn.createChannel();
      await publisherCh.assertExchange(slothResponseExchangeName, 'headers', { durable: true });
      const publish = (id: string): void => {
        publisherCh.publish(
          slothResponseExchangeName,
          nackConfig.routingKey,
          Buffer.from(JSON.stringify({ id })),
          { headers: { service: nackConfig.serviceName }, persistent: true },
        );
      };
      publish('poison');
      publish('sentinel');

      await sentinelArrived;
      // With requeue=false and no DLX policy on the queue, the broker must
      // drop the nacked message. Give an (incorrect) redelivery a moment to
      // show up before pinning the exact delivery sequence.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seen).toEqual(['poison', 'sentinel']);
    } finally {
      await publisherConn.close().catch(() => {});
    }
  });
});

// ─── test d: consumer timeout ────────────────────────────────────────────────

interface LoggedEvent {
  atMs: number;
  event: string;
  reason: string;
}

const recordingLogger = (events: LoggedEvent[]): SlothLogger => {
  const record = (_msg: string, meta?: unknown): void => {
    const event: unknown = Reflect.get(Object(meta), 'event');
    const reason: unknown = Reflect.get(Object(meta), 'reason');
    events.push({
      atMs: Date.now(),
      event: typeof event === 'string' ? event : '',
      reason: typeof reason === 'string' ? reason : '',
    });
  };
  const logger: SlothLogger = {
    info: record,
    warn: record,
    error: record,
    debug: record,
    child: () => logger,
  };
  return logger;
};

const loggedReasons = (events: LoggedEvent[], event: string): string[] =>
  events.filter((e) => e.event === event).map((e) => e.reason);

// Test d runs in its own vhost so its leak check counts only its own
// connections; the other tests keep listeners open until afterAll.
const timeoutVhost = 'sloth-timeout';
let timeoutUrl: string;

const timeoutVhostConnections = async (): Promise<number> => {
  const { body } = await mgmt('GET', `/vhosts/${timeoutVhost}/connections`);
  return Array.isArray(body) ? body.length : -1;
};

const queuePath = (caseConfig: SlothConfig): string =>
  `/queues/${timeoutVhost}/${encodeURIComponent(getSlothQueueName(caseConfig))}`;

const queueSummary = async (caseConfig: SlothConfig): Promise<string> => {
  const { body } = await mgmt('GET', queuePath(caseConfig));
  const pick = (key: string): unknown => Reflect.get(Object(body), key);
  return JSON.stringify({
    type: pick('type'),
    policy: pick('policy'),
    consumers: pick('consumers'),
    ready: pick('messages_ready'),
    unacked: pick('messages_unacknowledged'),
  });
};

// The policy exists before the queue is declared: a quorum queue applies a later
// policy change through Raft, so the management API can show it before the
// queue enforces it, and a consumer attached in between got no timeout.
const prepareTimedQueue = async (caseConfig: SlothConfig): Promise<() => Promise<void>> => {
  const policy = `test-d-${caseConfig.serviceName}`;
  const policyPath = `/policies/${timeoutVhost}/${policy}`;
  const put = await mgmt('PUT', policyPath, {
    pattern: `^${escapeRegex(getSlothQueueName(caseConfig))}$`,
    'apply-to': 'queues',
    priority: 100,
    definition: { 'consumer-timeout': consumerTimeoutMs },
  });
  expect(put.status).toBeLessThan(300);
  const client = await amqp.connect(timeoutUrl);
  try {
    const channel = await client.createChannel();
    await channel.assertQueue(getSlothQueueName(caseConfig), {
      durable: true,
      expires: defaultListenerQueueExpiresMs,
    });
  } finally {
    await client.close();
  }
  await waitFor(
    async () => {
      const { body } = await mgmt('GET', queuePath(caseConfig));
      const effective = Reflect.get(Object(body), 'effective_policy_definition');
      return (
        Reflect.get(Object(body), 'policy') === policy &&
        Reflect.get(Object(effective), 'consumer-timeout') === consumerTimeoutMs
      );
    },
    30_000,
    () => `policy ${policy}`,
  );
  return async () => {
    await mgmt('DELETE', policyPath);
  };
};

const publishResponse = async (caseConfig: SlothConfig, id: string): Promise<void> => {
  const client = await amqp.connect(timeoutUrl);
  try {
    const channel = await client.createConfirmChannel();
    await channel.assertExchange(slothResponseExchangeName, 'headers', { durable: true });
    channel.publish(
      slothResponseExchangeName,
      caseConfig.routingKey,
      Buffer.from(JSON.stringify({ id })),
      { headers: { service: caseConfig.serviceName }, persistent: true },
    );
    await channel.waitForConfirms();
  } finally {
    await client.close();
  }
};

interface TimedCase {
  startedAtMs: number;
  closed: { atMs: number; reason: SlothListenerClosedReason }[];
  events: LoggedEvent[];
  delivered: { atMs: number; id: string; redelivered: boolean }[];
  releasedAtMs: number | undefined;
  handlerDone: Promise<void>;
  release: () => void;
  handle: SlothListenerHandle;
}

const startTimedListener = async (caseConfig: SlothConfig): Promise<TimedCase> => {
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let markHandlerDone!: () => void;
  const handlerDone = new Promise<void>((resolve) => {
    markHandlerDone = resolve;
  });
  const events: LoggedEvent[] = [];
  const closed: TimedCase['closed'] = [];
  const delivered: TimedCase['delivered'] = [];
  const handle = await setupDelayedMessageListener({
    amqpUrl: timeoutUrl,
    config: caseConfig,
    logger: recordingLogger(events),
    graceTimeoutMs: 100,
    onClosed: (reason) => closed.push({ atMs: Date.now(), reason }),
    onMessage: async (message) => {
      const { id } = JSON.parse(message.content.toString()) as { id: string };
      delivered.push({ atMs: Date.now(), id, redelivered: message.fields.redelivered });
      if (id === 'held') {
        await barrier;
        markHandlerDone();
      }
    },
  });
  const timed: TimedCase = {
    startedAtMs: Date.now(),
    closed,
    events,
    delivered,
    releasedAtMs: undefined,
    handlerDone,
    release: () => {
      timed.releasedAtMs = Date.now();
      releaseBarrier();
    },
    handle,
  };
  return timed;
};

// Timeline relative to the listener start, so a failing leg shows what happened.
const describeTimeline = (timed: TimedCase): string => {
  const at = (ms: number): string => `+${String(ms - timed.startedAtMs)}ms`;
  return JSON.stringify({
    delivered: timed.delivered.map((d) => `${at(d.atMs)} ${d.id}`),
    closed: timed.closed.map((c) => `${at(c.atMs)} ${c.reason}`),
    events: timed.events
      .filter(
        (e) => e.event !== 'sloth.listener.ready' && e.event !== 'sloth.listener.setup_started',
      )
      .map((e) => `${at(e.atMs)} ${e.event} ${e.reason}`),
    released: timed.releasedAtMs === undefined ? null : at(timed.releasedAtMs),
  });
};

const expectRedelivery = async (caseConfig: SlothConfig): Promise<void> => {
  let resolveRedelivered!: (redelivered: boolean) => void;
  const redelivered = new Promise<boolean>((resolve) => {
    resolveRedelivered = resolve;
  });
  const handle = await setupDelayedMessageListener({
    amqpUrl: timeoutUrl,
    config: caseConfig,
    logger: silentLogger,
    onMessage: (message) => {
      resolveRedelivered(message.fields.redelivered);
      return Promise.resolve();
    },
  });
  try {
    expect(await redelivered).toBe(true);
  } finally {
    await handle.close();
  }
};

const waitForTimeout = async (caseConfig: SlothConfig, timed: TimedCase): Promise<void> => {
  try {
    await waitFor(
      () => Promise.resolve(timed.closed.length > 0),
      consumerTimeoutMs * 2 + 30_000,
      () => `the consumer timeout on ${caseConfig.serviceName}: ${describeTimeline(timed)}`,
    );
    if (leg.timeoutExpect === 'channel-closed') {
      // Before 4.3 the broker closes the channel itself; the handler is still
      // held, so this cannot come from a late ack.
      await waitFor(
        () =>
          Promise.resolve(
            loggedReasons(timed.events, 'sloth.listener.channel_error').some((r) =>
              r.includes('PRECONDITION_FAILED'),
            ),
          ),
        5_000,
        () => `PRECONDITION_FAILED on ${caseConfig.serviceName}: ${describeTimeline(timed)}`,
      );
    }
  } catch (error) {
    throw new Error(`${String(error)} queue=${await queueSummary(caseConfig)}`, { cause: error });
  }
};

const runTimedOutCase = async (caseConfig: SlothConfig, releaseBeforeClose: boolean) => {
  const dropPolicy = await prepareTimedQueue(caseConfig);
  try {
    const timed = await startTimedListener(caseConfig);
    await publishResponse(caseConfig, 'held');
    await waitForTimeout(caseConfig, timed);

    const channelErrors = (): string[] =>
      loggedReasons(timed.events, 'sloth.listener.channel_error');
    if (releaseBeforeClose) {
      timed.release();
      await timed.handlerDone;
      if (leg.timeoutExpect === 'channel-closed') {
        await sleep(1_000);
        // amqplib throws synchronously on an ack to a broker-closed channel.
        expect(timed.events.map((e) => e.event)).toContain('sloth.listener.ack_failed');
      } else {
        // From 4.3 the channel is still open after the cancel; the late ack makes
        // amqplib 2.3.1 close it with 541 "Unknown consumer" (case 2, with no
        // ack, shows no such error).
        await waitFor(
          () => Promise.resolve(channelErrors().some((r) => r.includes('Unknown consumer'))),
          5_000,
          () => `541 after the late ack on ${caseConfig.serviceName}: ${describeTimeline(timed)}`,
        );
      }
      await timed.handle.close();
    } else {
      if (leg.timeoutExpect === 'consumer-cancelled') {
        expect(channelErrors()).toEqual([]);
      }
      await timed.handle.close();
      timed.release();
      await timed.handlerDone;
    }
    console.info(`test-d-outcome case=${caseConfig.serviceName} ${describeTimeline(timed)}`);
    expect(timed.closed.map((c) => c.reason)).toEqual([leg.timeoutExpect]);
    await expectRedelivery(caseConfig);
  } finally {
    await dropPolicy();
  }
};

const runNoTimeoutCase = async (caseConfig: SlothConfig) => {
  const dropPolicy = await prepareTimedQueue(caseConfig);
  try {
    const timed = await startTimedListener(caseConfig);
    await publishResponse(caseConfig, 'held');
    await waitFor(
      () => Promise.resolve(timed.delivered.length === 1),
      10_000,
      () => `the delivery: ${describeTimeline(timed)}`,
    );
    await sleep(130_000);
    expect(timed.closed).toEqual([]);
    timed.release();
    await timed.handlerDone;
    await publishResponse(caseConfig, 'sentinel');
    await waitFor(
      () => Promise.resolve(timed.delivered.some((d) => d.id === 'sentinel')),
      10_000,
      () => `the sentinel: ${describeTimeline(timed)}`,
    );
    console.info(`test-d-outcome case=${caseConfig.serviceName} ${describeTimeline(timed)}`);
    expect(timed.delivered.map((d) => d.id)).toEqual(['held', 'sentinel']);
    await timed.handle.close();
  } finally {
    await dropPolicy();
  }
};

describe('consumer timeout: the listener reports it and the message comes back', () => {
  beforeAll(async () => {
    const created = await mgmt('PUT', `/vhosts/${timeoutVhost}`, {
      default_queue_type: leg.vhostDefault,
    });
    const granted = await mgmt('PUT', `/permissions/${timeoutVhost}/${brokerUser}`, {
      configure: '.*',
      write: '.*',
      read: '.*',
    });
    if (created.status >= 300 || granted.status >= 300) {
      throw new Error(
        `timeout vhost setup failed (${String(created.status)}/${String(granted.status)})`,
      );
    }
    timeoutUrl = `${amqpBaseUrl}/${timeoutVhost}`;
  });

  it('d. consumer timeout behaves as the leg expects, with no leaked connection', async () => {
    if (leg.timeoutExpect === 'none') {
      await runNoTimeoutCase({ serviceName: 'integration-timeout', routingKey: 'timeout.none' });
    } else {
      await Promise.all([
        runTimedOutCase(
          { serviceName: 'integration-timeout-early', routingKey: 'timeout.early' },
          true,
        ),
        runTimedOutCase(
          { serviceName: 'integration-timeout-late', routingKey: 'timeout.late' },
          false,
        ),
      ]);
    }
    let open = -1;
    await waitFor(
      async () => {
        open = await timeoutVhostConnections();
        return open === 0;
      },
      30_000,
      () => `test d's connections to close (${String(open)} still open)`,
    );
  }, 180_000);
});

const silentLogger: SlothLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};
