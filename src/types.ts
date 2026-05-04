import type { ChannelModel, ConsumeMessage } from 'amqplib';
import type { SlothLogger } from './logger.js';
import type { SlothConfig } from './utils.js';

export interface SendDelayMessageParams {
  data: { key: string; [key: string]: unknown };
  delayMinutes: number;
  logger: SlothLogger;
  config: SlothConfig;
}

export interface SlothListenerOptions {
  amqpUrl: string;
  config: SlothConfig;
  logger?: SlothLogger;
  onMessage: (message: ConsumeMessage) => Promise<void>;
}

export type SlothSetup = (client: ChannelModel) => Promise<void>;
