import { z } from 'zod';

export const msgTypes = z.enum({
  sound_data_from_client: 'sound_data_from_client',
  sound_data_from_ai: 'sound_data_from_ai',
  message: 'message',
  broadcast: 'broadcast',
});

export const msgDataFromClientSchema = z.object({
  mimeType: z.string(),
  message: z.string().optional(),
  chunk: z.string(),    // Base 64 encoded audio chunk
  sequence: z.number(),
});

export type MsgDataFromClient = z.infer<typeof msgDataFromClientSchema>;

