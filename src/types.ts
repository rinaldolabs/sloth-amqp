import type { ChannelModel, ConsumeMessage } from 'amqplib';
import type { SlothLogger, SlothLogLevel } from './logger.js';
import type { SlothConfig } from './utils.js';

export type DelaySpec =
  | { delayMinutes: number; delaySeconds?: never; delayUntil?: never }
  | { delaySeconds: number; delayMinutes?: never; delayUntil?: never }
  | { delayUntil: Date; delayMinutes?: never; delaySeconds?: never };

/**
 * A message this library has published. Emitted after the broker confirms the
 * publish — failed or timed-out publishes never reach the wire tap; observe
 * those via the `sloth.publish.failed` log event instead.
 */
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

/** Opt-in response queue type for {@link SlothListenerOptions.queueType}. */
export type SlothQueueType = 'quorum';

/** Options for {@link createDelaySender}. */
export interface DelaySenderOptions {
  /**
   * Publish with AMQP `mandatory` so a request that no queue receives (Sloth
   * not running on this broker yet, or its request queue expired) makes `send`
   * reject with a `SlothPublishError` instead of resolving. Off by default: an
   * unroutable request is then confirmed and dropped. When on, every publish
   * carries an `x-sloth-publish-id` header, and passing that header in
   * `params.headers` throws.
   */
  mandatory?: boolean;
}

/**
 * Why a listener died without `close()` being called. Passed to
 * {@link SlothListenerOptions.onClosed}.
 *
 * - `'connection-closed'` — the AMQP connection dropped (broker restart,
 *   heartbeat timeout, network partition).
 * - `'channel-closed'` — the broker closed the channel while the connection
 *   stayed up (protocol error, queue deleted).
 * - `'consumer-cancelled'` — the broker cancelled this consumer server-side
 *   (queue deleted, node failover with a non-HA queue).
 */
export type SlothListenerClosedReason =
  'connection-closed' | 'channel-closed' | 'consumer-cancelled';

export interface SlothListenerOptions {
  amqpUrl: string;
  config: SlothConfig;
  logger?: SlothLogger;
  onMessage: (message: ConsumeMessage) => Promise<void>;
  /**
   * Opt-in death notification. Fired at most once, only after setup succeeded,
   * and never as a result of the caller's own `close()`. The listener does
   * **not** reconnect by itself — when this fires, the consumer is dead and no
   * further messages will be delivered. Re-run `setupDelayedMessageListener`
   * (ideally with backoff), or exit and let your orchestrator restart the
   * process. A throwing callback is caught and logged
   * (`sloth.listener.on_closed_failed`), never rethrown.
   */
  onClosed?: (reason: SlothListenerClosedReason) => void;
  queueExpiresMs?: number;
  /**
   * Response queue type. Omitted: no `x-queue-type` is sent, so the vhost's
   * default queue type decides (classic on a default broker). `'quorum'`
   * declares the queue with `x-queue-type: quorum` and
   * `x-single-active-consumer: true`, the default shape Sloth's Go client
   * v1.0.0 and v1.0.1 declare, so a Node and a Go service can share it when
   * `queueExpiresMs` keeps its default and the Go side adds no dead-letter
   * option. A queue's type is fixed when it is created: switching
   * an existing queue needs a drain or a fresh broker.
   */
  queueType?: SlothQueueType;
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
  /**
   * Max time `handle.close()` waits for in-flight `onMessage` handlers to
   * settle after cancelling the consumer, before closing the channel. Defaults
   * to `10_000` (10s). A clean drain avoids the broker requeuing
   * still-processing messages (which would redeliver them with
   * `redelivered: true` on next connect). Delivery is at-least-once regardless,
   * so handlers must be idempotent. Must be a non-negative integer; `0` skips
   * the wait.
   */
  graceTimeoutMs?: number;
}

export interface SlothListenerHandle extends AsyncDisposable {
  readonly consumerTag: string;
  close(): Promise<void>;
  /** Alias for {@link close}, enabling `await using handle = …`. */
  [Symbol.asyncDispose](): Promise<void>;
}

export type SlothSetup = (client: ChannelModel) => Promise<void>;
