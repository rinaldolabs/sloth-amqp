import amqp, { type ChannelModel } from 'amqplib';
import type { SlothSetup } from './types.js';

export const slothConnect = async (url: string, ...opts: SlothSetup[]): Promise<ChannelModel> => {
  if (!url) {
    throw new Error('AMQP URL must not be empty');
  }
  const client = await amqp.connect(url);
  await Promise.all(opts.map((fn) => fn(client)));
  return client;
};

export const slothClose = (client: ChannelModel): Promise<void> => client.close();
