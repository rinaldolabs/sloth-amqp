import type { ChannelModel, ConsumeMessage } from 'amqplib';
import type { SlothLogger, SlothLogLevel } from './logger.js';
import type { SlothConfig } from './utils.js';

export type DelaySpec =
  | { delayMinutes: number; delaySeconds?: never; delayUntil?: never }
  | { delaySeconds: number; delayMinutes?: never; delayUntil?: never }
  | { delayUntil: Date; delayMinutes?: never; delaySeconds?: never };

/** A message this library is about to publish. */
export interface SlothWireOutbound {
  readonly direction: 'out';
  readonly exchange: string;
  readonly routingKey: string;
  readonly content: Buffer;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly messageId?: string;
  readonly correlationId?: string;
}

/** A message this library has just received. */
export interface SlothWireInbound {
  readonly direction: 'in';
  readonly queue: string;
  readonly routingKey: string;
  readonly content: Buffer;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly redelivered: boolean;
}

export type SlothWireEvent = SlothWireOutbound | SlothWireInbound;

/**
 * Opt-in tap on the raw bytes crossing the wire — one call per publish
 * (outbound) and per delivery (inbound). Lets a caller observe payloads/routing
 * without the library logging them itself (its structured logs never include
 * message bodies). The hook is invoked synchronously and is **not awaited**; if
 * it throws, the error is caught and logged (`sloth.wire.hook_failed`) and
 * publish/consume proceeds. Treat `content` as read-only and do not retain it.
 */
export type OnWireMessage = (event: SlothWireEvent) => void;

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
  /** Opt-in tap on the outbound message bytes. See {@link OnWireMessage}. */
  onWireMessage?: OnWireMessage;
  /**
   * Bounds the wait for the broker's publish confirm. On expiry `send` rejects
   * with a `SlothTimeoutError`. **At-least-once caveat:** a timed-out publish
   * may still have reached the broker — design consumers to be idempotent. The
   * cached channel is kept (the message may yet confirm); only a broker
   * error/close recreates it.
   */
  timeoutMs?: number;
  /**
   * Caller `AbortSignal` bounding the confirm wait — same semantics as
   * `timeoutMs`; whichever fires first wins. A caller-`abort()` rejects with
   * the signal's reason verbatim (not a `SlothTimeoutError`).
   */
  signal?: AbortSignal;
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
  /** Opt-in tap on each inbound message's bytes. See {@link OnWireMessage}. */
  onWireMessage?: OnWireMessage;
}

export interface SlothListenerHandle {
  readonly consumerTag: string;
  close(): Promise<void>;
}

export type SlothSetup = (client: ChannelModel) => Promise<void>;
