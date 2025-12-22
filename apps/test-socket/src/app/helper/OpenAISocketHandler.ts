import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { Logger } from '@nestjs/common';

// Lightweight interface describing the subset of the WS API this class uses.
export interface IWebSocket {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string | ArrayBufferLike | Blob): void;
  close(): void;
  removeAllListeners?: () => void;
}

export interface RealtimeSessionOptions {
  model?: string;
  voice?: string;
  instructions?: string;
  inputSampleRate?: number;
  outputSampleRate?: number;
}

export type AudioDeltaPayload = {
  base64: string;
  format: string;
  sampleRate: number;
  responseId?: string;
};

const DEFAULT_OPTIONS: Required<Omit<RealtimeSessionOptions, 'instructions'>> & Pick<RealtimeSessionOptions, 'instructions'> = {
  model: 'gpt-4o-realtime-preview',
  voice: 'alloy',
  inputSampleRate: 16000,
  outputSampleRate: 16000,
  instructions: undefined,
};

/**
 * Helper class that encapsulates WebSocket interaction with OpenAI Realtime API.
 */
export class OpenAIRealtimeSocketHandler {
  ws!: IWebSocket;
  events: EventEmitter;
  private options: Required<RealtimeSessionOptions>;
  private awaitingResponse = false;
  private readyPromise: Promise<void> | null = null;
  private readonly logger = new Logger(OpenAIRealtimeSocketHandler.name);
  private connectStartedAt = 0;
  private pendingInputChunks: Array<{ sentAt: number; size: number }> = [];
  private lastAudioDeltaAt = 0;

  constructor(opts?: RealtimeSessionOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...opts,
      inputSampleRate: opts?.inputSampleRate ?? DEFAULT_OPTIONS.inputSampleRate,
      outputSampleRate: opts?.outputSampleRate ?? DEFAULT_OPTIONS.outputSampleRate,
      voice: opts?.voice ?? DEFAULT_OPTIONS.voice,
      model: opts?.model ?? DEFAULT_OPTIONS.model,
      instructions: opts?.instructions ?? DEFAULT_OPTIONS.instructions,
    } as Required<RealtimeSessionOptions>;
    this.events = new EventEmitter();
  }

  connectToAudioStream(): Promise<void> {
    this.connectStartedAt = Date.now();
    const rawWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    });

    // Cast the raw WebSocket to our lightweight IWebSocket so we can call .on(...)
    this.ws = rawWs as unknown as IWebSocket;
    this.attachHandlers();
    this.readyPromise = new Promise((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (err: unknown) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        if (typeof (this.ws as WebSocket).removeListener === 'function') {
          (this.ws as WebSocket).removeListener('open', handleOpen);
          (this.ws as WebSocket).removeListener('error', handleError);
        }
      };

      this.ws.on('open', handleOpen);
      this.ws.on('error', handleError);
    });
    return this.readyPromise;
  }

  async waitUntilReady() {
    if (!this.readyPromise) {
      await this.connectToAudioStream();
      return;
    }
    await this.readyPromise;
  }

  /** Attach WebSocket event listeners and forward parsed messages via events. */
  private attachHandlers() {
    console.log('Attaching OpenAI Realtime WebSocket handlers...');

    this.ws.on('open', () => this.handleOpen());
    this.ws.on('message', (data: unknown) => this.handleMessage(data));
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.events.emit('close', { code, reason });
    });
    this.ws.on('error', (err: unknown) => {
      this.events.emit('error', err);
    });
  }

  private handleOpen() {
    const handshakeDuration = Date.now() - this.connectStartedAt;
    this.logger.debug(`[latency] OpenAI websocket open after ${handshakeDuration} ms`);
    console.log('OpenAI Realtime WebSocket connection opened.');
    this.sendSessionCreate();
  }

  /** Send the session.create message required by the OpenAI realtime endpoint. */
  private sendSessionCreate() {
    this.logger.debug('Sending session.update to OpenAI Realtime');
    const event = {
      "type": "session.update",
      "session": {
        "type": "realtime",
        "model": "gpt-realtime",
        "instructions": "Du bist ein Simultanübersetzer. Übersetze fortlaufend von Deutsch nach Englisch. Antworte ausschließlich mit der Übersetzung, keine Kommentare.",
        "audio": {
          "input": {
            "format": { "type": "audio/pcm", "rate": 24000 },
            "turn_detection": { "type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 200, "silence_duration_ms": 250 }
          },
          "output": {
            "voice": "marin"
          }
        }
      }
    };
    /*
    const event = {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        // Lock the output to audio (set to ["text"] if you want text without audio)
        output_modalities: ["audio"],
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            turn_detection: {
              type: "semantic_vad"
            }
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            voice: "marin",
          },
          instructions: 'Translate the incoming speech to fluent English and keep the same tone.',
        },
        instructions: "Speak clearly and briefly. Confirm understanding before taking actions."
      },
    };*/
    this.ws.send(JSON.stringify(event));
  }

  /** Create a response request so OpenAI starts streaming translation output */
  public requestResponse(extraInstructions?: string) {
    const instructions = extraInstructions ?? this.options.instructions ?? 'Translate the incoming speech to fluent English and keep the same tone.';
    this.awaitingResponse = true;
    this.logger.debug('response.create requested from OpenAI');
    this.ws.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions,
        modalities: ['text', 'audio'],
        audio: {
          format: 'pcm16',
          voice: this.options.voice,
          sample_rate: 24000,
        },
      },
    }));
  }

  public markResponseComplete() {
    this.awaitingResponse = false;
  }

  public isAwaitingResponse() {
    return this.awaitingResponse;
  }

  /**
   * Handle incoming raw WebSocket messages, parse and emit higher-level events.
   */
  private handleMessage(data: unknown) {
    let msg: any;

    try {
      // 1. Konvertierung der Rohdaten in einen String
      let rawString: string;
      if (typeof data === 'string') {
        rawString = data;
      } else if (Buffer.isBuffer(data)) {
        rawString = data.toString('utf-8');
      } else if (data instanceof ArrayBuffer) {
        rawString = Buffer.from(data).toString('utf-8');
      } else {
        this.events.emit('raw', data);
        return;
      }

      // 2. JSON Parsing
      msg = JSON.parse(rawString);
    } catch (err) {
      console.error('Failed to parse OpenAI message:', err);
      this.events.emit('error', { type: 'parse_error', details: err.message });
      return;
    }

    // 3. Typprüfung
    if (!msg || typeof msg.type !== 'string') {
      this.events.emit('raw', msg);
      return;
    }

    // 4. Event Dispatching basierend auf dem OpenAI Message-Typ
    console.log('OpenAI Realtime Message:', msg.type);
    switch (msg.type) {
      case 'response.output_audio.delta':
        if (msg.delta) {
          const payload: AudioDeltaPayload = {
            base64: msg.delta,
            format: 'pcm16',
            sampleRate: 24000,
            responseId: msg.response_id,
          };
          const pending = this.pendingInputChunks.shift();
          if (pending) {
            const latency = Date.now() - pending.sentAt;
            this.logger.debug(`[latency] OpenAI process ${latency} ms for ${pending.size} bytes -> audio delta (${payload.base64.length} b64 chars)`);
          } else {
            this.logger.debug('[latency] Audio delta without pending input telemetry');
          }
          this.lastAudioDeltaAt = Date.now();
          this.events.emit('audio.output', payload);
        }
        break;

      case 'response.output_text.delta':
        if (msg.delta) {
          this.events.emit('transcript', msg.delta);
        }
        break;

      case 'response.audio_transcript.delta':
        // Dies ist das Transkript der KI-Stimme (Text der gesprochen wird)
        if (msg.delta) {
          console.log('AI-Transkript:', msg.delta);
          this.events.emit('audio_transcript', msg.delta);
        }
        break;

      case 'response.completed':
        this.markResponseComplete();
        this.events.emit('response.complete', msg);
        break;

      case 'error':
        console.error('OpenAI Realtime Error:', msg.error);
        this.events.emit('error', msg.error);
        break;

      case 'session.created':
      case 'session.updated':
        this.events.emit('session.info', msg.session);
        break;

      default:
        // Alle anderen Events (z.B. VAD, Heartbeats) werden als 'raw' weitergegeben
        this.events.emit('raw', msg);
        break;
    }
  }

  public sendAudioChunk(buffer: Buffer) {
    const now = Date.now();
    if (!this.lastAudioDeltaAt) {
      this.lastAudioDeltaAt = now;
    }
    this.pendingInputChunks.push({ sentAt: now, size: buffer.length });
    this.logger.debug(`[latency] queued chunk ${this.pendingInputChunks.length} (${buffer.length} bytes)`);
    console.log('Sending audio chunk to OpenAI Realtime WebSocket...');
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: buffer.toString('base64'),
    }));
  }

  public commitAudio() {
    this.logger.debug('input_audio_buffer.commit sent to OpenAI');
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  public close() {
    try {
      this.ws.close();
    } catch (err) {
      console.debug(err);
    }
  }
}
