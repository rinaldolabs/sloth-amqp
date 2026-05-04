// Wire protocol constants for gitlab.com/unboundsoftware/sloth amqp:0.0.10
// See: ServiceRequestConsumer("delay", ...) and PublishServiceResponse(...) in amqp.go
export const slothRequestExchangeName = 'sloth.direct.exchange.request';
export const slothResponseExchangeName = 'sloth.headers.exchange.response';

// SlothConfig mirrors the Go client's New(serviceName, amqpURL, ...mappings) signature:
// serviceName and routingKey are mandatory — the Sloth server uses them to route the response
// back to the correct queue. gitlab.com/unboundsoftware/sloth/client-amqp/client.go
export interface SlothConfig {
  serviceName: string;
  routingKey: string;
}

// Queue name follows Sloth's PublishServiceResponse convention: {responseExchange}.queue.{serviceName}
export const getSlothQueueName = (config: SlothConfig): string =>
  `${slothResponseExchangeName}.queue.${config.serviceName}`;

// target header format: amqp://{serviceName}/{routingKey}/ — Sloth uses this to re-deliver the message
export const getSlothTarget = (config: SlothConfig): string =>
  `amqp://${config.serviceName}/${config.routingKey}/`;
