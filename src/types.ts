import type { ChannelModel, ConsumeMessage } from 'amqplib';
import type { SlothLogger, SlothLogLevel } from './logger.js';
import type { SlothConfig } from './utils.js';

export type DelaySpec =
  | { delayMinutes: number; delaySeconds?: never; delayUntil?: never }
  | { delaySeconds: number; delayMinutes?: never; delayUntil?: never }
  | { delayUntil: Date; delayMinutes?: never; delaySeconds?: never };

type SendDelayMessageBase<TData = unknown> = {
  data: TData;
  logger: SlothLogger;
  config: SlothConfig;
  /** Optional human-readable label used in log lines. Falls back to 'message'. */
  logLabel?: string;
  /** Optional minimum level for this library's log calls. Caller's logger is otherwise untouched. */
  logLevel?: SlothLogLevel;
  /**
   * Override the auto-generated message ID. By default, every send gets a
   * fresh `crypto.randomUUID()` published as AMQP `messageId`. Provide your
   * own when you need deterministic IDs for idempotency stores.
   */
  messageId?: string;
  /**
   * Optional correlation ID for tracking related messages across services.
   * Forwarded as the AMQP `correlationId` property; consumers can read it
   * via `message.properties.correlationId`.
   */
  correlationId?: string;
  /**
   * Extra AMQP headers merged onto the published message. Use this to forward
   * W3C trace context (`traceparent`, `tracestate`) so distributed traces
   * survive the Sloth hop.
   *
   * The headers `delay-until` and `target` are reserved by the Sloth wire
   * protocol — passing them here throws before any AMQP work happens.
   */
  headers?: Record<string, string | number | boolean>;
};

export type SendDelayMessageParams<TData = unknown> = SendDelayMessageBase<TData> & DelaySpec;

export interface SlothListenerOptions {
  amqpUrl: string;
  config: SlothConfig;
  logger?: SlothLogger;
  onMessage: (message: ConsumeMessage) => Promise<void>;
  queueExpiresMs?: number;
  /**
   * Consumer prefetch (QoS) — the maximum number of unacknowledged messages
   * the broker will deliver to this consumer at once. Defaults to `20`.
   * Sloth re-delivers in bursts when many delayed messages come due together,
   * so an unbounded prefetch (`0`) risks holding the whole burst in memory;
   * keep a bounded window unless you have a specific reason. Set `0` for
   * unlimited. Must be a non-negative integer.
   */
  prefetch?: number;
  // Optional minimum level for this library's log calls. Caller's logger is otherwise untouched.
  logLevel?: SlothLogLevel;
  /**
   * Optional cancellation. Bounds the listener-setup phase
   * (connect → assertExchange → assertQueue → bindQueue → consume).
   * After the handle is returned the signal stops mattering — manage
   * lifetime via `handle.close()`.
   */
  signal?: AbortSignal;
  /** Convenience timeout for the same setup phase. */
  timeoutMs?: number;
}

export interface SlothListenerHandle {
  readonly consumerTag: string;
  close(): Promise<void>;
}

export type SlothSetup = (client: ChannelModel) => Promise<void>;
