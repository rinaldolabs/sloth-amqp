import type { ChannelModel, ConsumeMessage } from 'amqplib';
import type { SlothLogger } from './logger.js';
import type { SlothConfig } from './utils.js';

export interface SendDelayMessageParams<TData = unknown> {
  data: TData;
  delayMinutes: number;
  logger: SlothLogger;
  config: SlothConfig;
  // Optional human-readable label used in log lines. Falls back to 'message'.
  logLabel?: string;
}

export interface SlothListenerOptions {
  amqpUrl: string;
  config: SlothConfig;
  logger?: SlothLogger;
  onMessage: (message: ConsumeMessage) => Promise<void>;
  queueExpiresMs?: number;
}

export interface SlothListenerHandle {
  readonly consumerTag: string;
  close(): Promise<void>;
}

export type SlothSetup = (client: ChannelModel) => Promise<void>;
