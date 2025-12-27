import { EventEmitter } from 'events';
import { Injectable, Logger } from '@nestjs/common';
import { OpenAIRealtimeSocketHandler } from '../app/helper/OpenAISocketHandler';

export interface OpenAiRtcSessionOptions {
  model?: string;
  voice?: string;
  inputSampleRate?: number;
  outputSampleRate?: number;
  instructions?: string;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

export type PartialTranscriptPayload = {
  delta: string;
  text: string;
};

export type TtsChunkPayload = {
  base64: string;
  format: string;
  sampleRate: number;
  responseId?: string;
};

export interface OpenAiRtcSession {
  events: EventEmitter;
  connect(): Promise<void>;
  sendAudioChunk(chunk: Buffer): void;
  commitAudio(): void;
  requestResponse(instructions?: string): void;
  close(): void;
}

const DEFAULT_INSTRUCTIONS =
  'Du bist ein Simultanübersetzer. Übersetze fortlaufend von Deutsch nach Englisch. Antworte ausschließlich mit der Übersetzung, keine Kommentare.';

@Injectable()
export class OpenAiRtcService {
  createSession(options: OpenAiRtcSessionOptions = {}): OpenAiRtcSession {
    return new OpenAiRtcSessionImpl(options);
  }
}

class OpenAiRtcSessionImpl implements OpenAiRtcSession {
  events = new EventEmitter();
  private readonly logger = new Logger(OpenAiRtcSessionImpl.name);
  private readonly options: OpenAiRtcSessionOptions;
  private handler: OpenAIRealtimeSocketHandler | null = null;
  private closed = false;
  private retryCount = 0;
  private retryTimer?: NodeJS.Timeout;
  private pendingAudio: Buffer[] = [];
  private partialTranscript = '';
  private ready = false;

  constructor(options: OpenAiRtcSessionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.ready = false;

    if (this.handler) {
      this.handler.close();
    }

    this.handler = new OpenAIRealtimeSocketHandler({
      model: this.options.model,
      voice: this.options.voice,
      inputSampleRate: this.options.inputSampleRate ?? 24_000,
      outputSampleRate: this.options.outputSampleRate ?? 24_000,
      instructions: this.options.instructions ?? DEFAULT_INSTRUCTIONS,
    });

    this.attachHandlers(this.handler);

    try {
      await this.handler.connectToAudioStream();
      this.retryCount = 0;
      this.ready = true;
      this.flushPendingAudio();
    } catch (error) {
      this.logger.error('Failed to connect to OpenAI RTC session', error as Error);
      this.scheduleReconnect('connect_failed');
    }
  }

  sendAudioChunk(chunk: Buffer): void {
    if (this.closed) {
      return;
    }

    if (!this.ready || !this.handler) {
      this.pendingAudio.push(chunk);
      return;
    }

    this.handler.sendAudioChunk(chunk);
  }

  commitAudio(): void {
    if (!this.handler || !this.ready) {
      return;
    }

    this.handler.commitAudio();
  }

  requestResponse(instructions?: string): void {
    if (!this.handler || !this.ready) {
      return;
    }

    this.handler.requestResponse(instructions ?? this.options.instructions ?? DEFAULT_INSTRUCTIONS);
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.handler?.close();
  }

  private attachHandlers(handler: OpenAIRealtimeSocketHandler): void {
    handler.events.on('audio.output', (payload) => {
      this.events.emit('tts.chunk', payload as TtsChunkPayload);
    });

    handler.events.on('transcript', (delta) => {
      if (typeof delta === 'string') {
        this.partialTranscript += delta;
        const payload: PartialTranscriptPayload = {
          delta,
          text: this.partialTranscript,
        };
        this.events.emit('transcript.partial', payload);
      }
    });

    handler.events.on('response.complete', () => {
      this.partialTranscript = '';
    });

    handler.events.on('error', (err) => {
      this.logger.warn('OpenAI RTC session error', err as Error);
      this.events.emit('error', err);
      this.scheduleReconnect('error_event');
    });

    handler.events.on('close', (info) => {
      if (!this.closed) {
        this.logger.warn('OpenAI RTC session closed unexpectedly', info as Error);
        this.scheduleReconnect('socket_closed');
      }
    });
  }

  private flushPendingAudio(): void {
    if (!this.handler || !this.ready || this.pendingAudio.length === 0) {
      return;
    }

    const queued = [...this.pendingAudio];
    this.pendingAudio = [];
    queued.forEach((chunk) => this.handler?.sendAudioChunk(chunk));
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed) {
      return;
    }

    const maxRetries = this.options.maxRetries ?? 3;
    if (this.retryCount >= maxRetries) {
      this.events.emit('error', new Error(`OpenAI RTC session retry limit reached (${reason}).`));
      return;
    }

    const delay = (this.options.baseRetryDelayMs ?? 500) * Math.pow(2, this.retryCount);
    this.retryCount += 1;
    this.logger.warn(`Scheduling OpenAI RTC reconnect in ${delay} ms (${reason})`);
    this.retryTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }
}
