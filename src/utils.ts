import { hostname } from 'node:os';

// Wire protocol constants for the Sloth amqp source plugin.
// See: ServiceRequestConsumer("delay", ...) and PublishServiceResponse(...) in
// gitlab.com/unboundsoftware/sloth/amqp/amqp.go
export const slothRequestExchangeName = 'sloth.direct.exchange.request';
export const slothResponseExchangeName = 'sloth.headers.exchange.response';

export const defaultListenerQueueExpiresMs = 5 * 24 * 60 * 60 * 1000;

// Default consumer prefetch (QoS). A bounded window protects against holding a
// full burst of due-now redeliveries in memory; 20 is the common balance
// between pipelining and bounded unacked messages. Override per-listener.
export const defaultListenerPrefetch = 20;

// SlothConfig mirrors the Go client's New(serviceName, amqpURL, ...mappings) signature:
// serviceName and routingKey are mandatory — the Sloth server uses them to route the response
// back to the correct queue. gitlab.com/unboundsoftware/sloth/client-amqp/client.go
export interface SlothConfig {
  serviceName: string;
  routingKey: string;
}

const safeIdentifier = /^[A-Za-z0-9._-]+$/;

const assertSafeIdentifier = (value: string, fieldName: string): void => {
  if (typeof value !== 'string' || !safeIdentifier.test(value)) {
    throw new Error(`${fieldName} must match [A-Za-z0-9._-]+`);
  }
};

export const assertSafeSlothConfig = (config: SlothConfig): void => {
  assertSafeIdentifier(config.serviceName, 'serviceName');
  assertSafeIdentifier(config.routingKey, 'routingKey');
};

// Queue name follows Sloth's PublishServiceResponse convention: {responseExchange}.queue.{serviceName}
export const getSlothQueueName = (config: SlothConfig): string => {
  assertSafeSlothConfig(config);
  return `${slothResponseExchangeName}.queue.${config.serviceName}`;
};

// Builds an AMQP `clientProperties` object with a `connection_name` for broker
// observability (RabbitMQ management UI / list_connections). Pass the result as
// `clientProperties` to slothConnect. When `connectionName` is omitted it
// defaults to `<serviceName>:sloth-amqp@<hostname>` so each service is
// identifiable. The hostname is a pod/task id in container environments but can
// be a personal machine name locally — pass an explicit `connectionName` if
// that matters. Never includes credentials or the AMQP URL.
export const slothClientProperties = (params: {
  serviceName: string;
  connectionName?: string;
}): Record<string, unknown> => {
  assertSafeIdentifier(params.serviceName, 'serviceName');
  const connection_name = params.connectionName ?? `${params.serviceName}:sloth-amqp@${hostname()}`;
  return { connection_name };
};

// target header format: amqp://{serviceName}/{routingKey} — the Sloth server parses this with
// url.Parse and uses parsed.Path[1:] as the routing key, so a trailing slash would corrupt it.
// See gitlab.com/unboundsoftware/sloth/amqp/amqp.go (Sink.Publish).
export const getSlothTarget = (config: SlothConfig): string => {
  assertSafeSlothConfig(config);
  return `amqp://${config.serviceName}/${config.routingKey}`;
};
