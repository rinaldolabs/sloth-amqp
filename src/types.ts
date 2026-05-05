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
  // Optional human-readable label used in log lines. Falls back to 'message'.
  logLabel?: string;
  // Optional minimum level for this library's log calls. Caller's logger is otherwise untouched.
  logLevel?: SlothLogLevel;
};

export type SendDelayMessageParams<TData = unknown> = SendDelayMessageBase<TData> & DelaySpec;

export interface SlothListenerOptions {
  amqpUrl: string;
  config: SlothConfig;
  logger?: SlothLogger;
  onMessage: (message: ConsumeMessage) => Promise<void>;
  queueExpiresMs?: number;
  // Optional minimum level for this library's log calls. Caller's logger is otherwise untouched.
  logLevel?: SlothLogLevel;
}

export interface SlothListenerHandle {
  readonly consumerTag: string;
  close(): Promise<void>;
}

export type SlothSetup = (client: ChannelModel) => Promise<void>;
