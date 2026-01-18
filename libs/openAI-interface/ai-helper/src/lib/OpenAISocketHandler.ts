
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { Logger } from '@nestjs/common';

/**
 * Lightweight interface describing the subset of the WebSocket API
 * that this class requires for operation.
 * This abstraction allows for easier testing and mocking of WebSocket connections.
 */
export interface IWebSocket {
  /**
   * Registers an event listener for the specified event.
   * @param event - The event name to listen for (e.g., 'open', 'message', 'close', 'error')
   * @param listener - The callback function to invoke when the event occurs
   */
  on(event: string, listener: (...args: unknown[]) => void): void;

  /**
   * Sends data through the WebSocket connection.
   * @param data - The data to send (string, ArrayBuffer, or Blob)
   */
  send(data: string | ArrayBufferLike | Blob): void;

  /**
   * Closes the WebSocket connection.
   */
  close(): void;

  /**
   * Optional method to remove all registered event listeners.
   */
  removeAllListeners?: () => void;
}

/**
 * Configuration options for establishing a realtime session with OpenAI.
 */
export interface RealtimeSessionOptions {
  /**
   * The OpenAI model to use for the realtime session.
   * @default 'gpt-4o-realtime-preview'
   */
  model?: string;

  /**
   * The voice identifier for text-to-speech output.
   * @default 'alloy'
   */
  voice?: string;

  /**
   * Custom instructions to guide the AI's behavior during the session.
   * If not provided, a default simultaneous translation instruction is used.
   */
  instructions?: string;

  /**
   * Sample rate for incoming audio data in Hz.
   * @default 24000
   */
  inputSampleRate?: number;

  /**
   * Sample rate for outgoing audio data in Hz.
   * @default 24000
   */
  outputSampleRate?: number;

  /**
   * Duration in milliseconds to wait before automatically triggering translation.
   * If set, translation will start after this duration regardless of speech pauses.
   * @default undefined (disabled)
   */
  autoTranslationTimeout?: number;

  /**
   * Duration in milliseconds of silence required to trigger translation (VAD).
   * @default 250
   */
  silenceDurationMs?: number;
}

/**
 * Payload structure for audio delta events emitted when
 * OpenAI streams audio output back to the client.
 */
export type AudioDeltaPayload = {
  /** Base64-encoded audio data */
  base64: string;

  /** Audio format identifier (e.g., 'pcm16') */
  format: string;

  /** Sample rate of the audio in Hz */
  sampleRate: number;

  /** Optional identifier linking this audio to a specific response */
  responseId?: string;
};

/**
 * Default configuration values for realtime sessions.
 */
const DEFAULT_OPTIONS: Required<Omit<RealtimeSessionOptions, 'instructions' | 'autoTranslationTimeout'>> & Pick<RealtimeSessionOptions, 'instructions' | 'autoTranslationTimeout'> = {
  model: 'gpt-4o-realtime-preview',
  voice: 'alloy',
  inputSampleRate: 24000,
  outputSampleRate: 24000,
  silenceDurationMs: 250,
  instructions: undefined,
  autoTranslationTimeout: undefined,
};

/**
 * OpenAIRealtimeSocketHandler manages WebSocket communication with the OpenAI Realtime API.
 *
 * This class provides a high-level abstraction for:
 * - Establishing and maintaining a WebSocket connection to OpenAI's realtime endpoint
 * - Sending audio chunks for processing (e.g., speech-to-text, translation)
 * - Receiving and parsing streamed responses (audio output, transcripts)
 * - Handling session lifecycle and error recovery
 *
 * ## Events Emitted
 *
 * The handler emits the following events through the `events` EventEmitter:
 *
 * - `audio.output` - Fired when audio data is received from OpenAI (payload: {@link AudioDeltaPayload})
 * - `transcript` - Fired when a text transcript delta is received
 * - `audio_transcript` - Fired when the AI's spoken text transcript is received
 * - `response.complete` - Fired when a response has been fully processed
 * - `response.output_audio.done` - Fired when audio output streaming is complete
 * - `session.info` - Fired when session information is received (created/updated)
 * - `error` - Fired when an error occurs
 * - `close` - Fired when the WebSocket connection closes
 * - `raw` - Fired for unhandled message types
 *
 * ## Usage Example
 *
 * ```typescript
 * const handler = new OpenAIRealtimeSocketHandler({
 *   model: 'gpt-4o-realtime-preview',
 *   voice: 'alloy',
 *   inputSampleRate: 24000,
 *   outputSampleRate: 24000,
 *   instructions: 'Translate speech from German to English.',
 * });
 *
 * handler.events.on('audio.output', (payload) => {
 *   // Handle incoming audio data
 * });
 *
 * await handler.connectToAudioStream();
 * handler.sendAudioChunk(audioBuffer);
 * handler.commitAudio();
 * handler.requestResponse();
 * ```
 */
export class OpenAIRealtimeSocketHandler {
  /** The underlying WebSocket connection instance */
  ws!: IWebSocket;

  /** EventEmitter for broadcasting parsed events to subscribers */
  events: EventEmitter;

  /** Merged configuration options with defaults applied */
  private options: Required<RealtimeSessionOptions>;

  /** Flag indicating whether a response is currently being awaited */
  private awaitingResponse = false;

  /** Promise that resolves when the WebSocket connection is established */
  private readyPromise: Promise<void> | null = null;

  /** Logger instance for debugging and diagnostics */
  private readonly logger = new Logger(OpenAIRealtimeSocketHandler.name);

  /** Timestamp when the connection attempt started (for latency measurement) */
  private connectStartedAt = 0;

  /** Queue of pending input chunks for latency tracking */
  private pendingInputChunks: Array<{ sentAt: number; size: number }> = [];

  /** Timestamp of the last received audio delta (for latency tracking) */
  private lastAudioDeltaAt = 0;

  /** Timer for automatic translation triggering */
  private autoTranslationTimer: NodeJS.Timeout | null = null;

  /** Timestamp when audio started being received */
  private audioStartTime = 0;

  /**
   * Creates a new OpenAIRealtimeSocketHandler instance.
   *
   * @param opts - Optional configuration options for the realtime session.
   *               Unspecified options will use default values.
   */
  constructor(opts?: RealtimeSessionOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...opts,
      inputSampleRate: opts?.inputSampleRate ?? DEFAULT_OPTIONS.inputSampleRate,
      outputSampleRate: opts?.outputSampleRate ?? DEFAULT_OPTIONS.outputSampleRate,
      voice: opts?.voice ?? DEFAULT_OPTIONS.voice,
      model: opts?.model ?? DEFAULT_OPTIONS.model,
      instructions: opts?.instructions ?? DEFAULT_OPTIONS.instructions,
      silenceDurationMs: opts?.silenceDurationMs ?? DEFAULT_OPTIONS.silenceDurationMs,
      autoTranslationTimeout: opts?.autoTranslationTimeout ?? DEFAULT_OPTIONS.autoTranslationTimeout,
    } as Required<RealtimeSessionOptions>;
    this.events = new EventEmitter();
  }

  /**
   * Establishes a WebSocket connection to the OpenAI Realtime API.
   *
   * This method initiates the connection handshake and automatically
   * sends the session configuration once the connection is established.
   *
   * @returns A Promise that resolves when the connection is successfully established,
   *          or rejects if the connection fails.
   *
   * @throws Error if the connection cannot be established or authentication fails.
   *
   * @remarks
   * The API key is read from the `OPENAI_API_KEY` environment variable.
   * Ensure this variable is set before calling this method.
   */
  connectToAudioStream(): Promise<void> {
    this.connectStartedAt = Date.now();
    const rawWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    });

    // Cast the raw WebSocket to our lightweight interface for handler attachment
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

  /**
   * Waits until the WebSocket connection is ready for use.
   *
   * If no connection has been initiated, this method will automatically
   * call {@link connectToAudioStream} to establish one.
   *
   * @returns A Promise that resolves when the connection is ready.
   */
  async waitUntilReady() {
    if (!this.readyPromise) {
      await this.connectToAudioStream();
      return;
    }
    await this.readyPromise;
  }

  /**
   * Attaches event listeners to the WebSocket connection.
   *
   * This private method sets up handlers for all WebSocket events
   * and routes them to the appropriate handler methods.
   */
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

  /**
   * Handles the WebSocket 'open' event.
   *
   * Logs the connection latency and initiates the session configuration.
   */
  private handleOpen() {
    const handshakeDuration = Date.now() - this.connectStartedAt;
    this.logger.debug(`[latency] OpenAI websocket open after ${handshakeDuration} ms`);
    console.log('OpenAI Realtime WebSocket connection opened.');
    this.sendSessionCreate();
  }

  /**
   * Sends the session configuration to OpenAI.
   *
   * This method constructs and sends a 'session.update' message that configures:
   * - The AI model to use
   * - Voice activity detection (VAD) settings
   * - Audio input/output formats and sample rates
   * - System instructions for the AI
   */
  private sendSessionCreate() {
    this.logger.debug('Sending session.update to OpenAI Realtime');
    const event = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.options.model,
        instructions:
          this.options.instructions ??
          'You are a simultaneous translator. Translate continuously from German to English. Respond only with the translation, no comments.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: this.options.inputSampleRate },
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: this.options.silenceDurationMs },
          },
          output: {
            voice: this.options.voice,
            format: { type: 'audio/pcm', rate: this.options.outputSampleRate },
          },
        },
      },
    };
    this.ws.send(JSON.stringify(event));
  }

  /**
   * Requests OpenAI to generate a response based on the accumulated audio input.
   *
   * This triggers the AI to process all committed audio and begin streaming
   * the translation or response back to the client.
   *
   * @param extraInstructions - Optional instructions to override or supplement
   *                            the default session instructions for this specific response.
   */
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
          voice: this.options.voice,
          format: 'pcm16',
          sample_rate: this.options.outputSampleRate,
        },
      },
    }));
  }

  /**
   * Marks the current response as complete.
   *
   * This resets the internal state to allow new response requests.
   */
  public markResponseComplete() {
    this.awaitingResponse = false;
  }

  /**
   * Checks whether a response is currently being awaited.
   *
   * @returns `true` if waiting for a response, `false` otherwise.
   */
  public isAwaitingResponse() {
    return this.awaitingResponse;
  }

  /**
   * Processes incoming WebSocket messages from OpenAI.
   *
   * This method handles the parsing of raw WebSocket data and dispatches
   * events based on the message type. Supported message types include:
   *
   * - `response.output_audio.delta` - Streaming audio output chunks
   * - `response.output_audio.done` - Audio output completion
   * - `response.output_text.delta` - Streaming text transcript
   * - `response.audio_transcript.delta` - AI voice transcript
   * - `response.completed` - Full response completion
   * - `error` - Error messages from OpenAI
   * - `session.created` / `session.updated` - Session lifecycle events
   *
   * @param data - The raw message data from the WebSocket
   */
  private handleMessage(data: unknown) {
    let msg: any;

    try {
      // Step 1: Convert raw data to string
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

      // Step 2: Parse JSON
      msg = JSON.parse(rawString);
    } catch (err) {
      console.error('Failed to parse OpenAI message:', err);
      this.events.emit('error', { type: 'parse_error', details: err.message });
      return;
    }

    // Step 3: Validate message structure
    if (!msg || typeof msg.type !== 'string') {
      this.events.emit('raw', msg);
      return;
    }

    // Step 4: Dispatch events based on OpenAI message type
    console.log('OpenAI Realtime Message:', msg.type);
    if (msg.type !== 'response.output_audio.delta')
      console.log(msg);
    switch (msg.type) {
      case 'response.output_audio.done':
        console.log('OpenAI Realtime Response Complete!', msg);
        this.events.emit('response.output_audio.done', msg);
        break;
      case 'response.output_audio.delta':
        if (msg.delta) {
          const payload: AudioDeltaPayload = {
            base64: msg.delta,
            format: 'pcm16',
            sampleRate: this.options.outputSampleRate,
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
        // This is the transcript of the AI voice (text being spoken)
        if (msg.delta) {
          console.log('AI transcript:', msg.delta);
          this.events.emit('audio_transcript', msg.delta);
        }
        break;

      case 'response.completed':
        this.markResponseComplete();
        // Reset timer state but don't clear audioStartTime if we want continuous translation
        if (this.autoTranslationTimer) {
          clearTimeout(this.autoTranslationTimer);
          this.autoTranslationTimer = null;
        }
        this.audioStartTime = 0;
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
        // All other events (e.g., VAD events, heartbeats) are emitted as 'raw'
        this.events.emit('raw', msg);
        break;
    }
  }

  /**
   * Sends an audio chunk to OpenAI for processing.
   *
   * The audio data is base64-encoded and sent as an 'input_audio_buffer.append' message.
   * Multiple chunks can be sent before calling {@link commitAudio} to batch the input.
   *
   * @param buffer - The raw PCM audio data buffer to send.
   *
   * @remarks
   * The audio format should match the `inputSampleRate` specified in the session options.
   * Typically, this is 16-bit PCM at 24kHz.
   */
  public sendAudioChunk(buffer: Buffer) {
    const now = Date.now();
    if (!this.lastAudioDeltaAt) {
      this.lastAudioDeltaAt = now;
    }

    // Start or restart auto-translation timer on every audio chunk
    if (!this.audioStartTime) {
      this.audioStartTime = now;
    }
    this.startAutoTranslationTimer();

    this.pendingInputChunks.push({ sentAt: now, size: buffer.length });
    this.logger.debug(`[latency] queued chunk ${this.pendingInputChunks.length} (${buffer.length} bytes)`);
    console.log('Sending audio chunk to OpenAI Realtime WebSocket...');
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: buffer.toString('base64'),
    }));
  }

  /**
   * Commits the accumulated audio buffer for processing.
   *
   * This signals to OpenAI that all audio chunks sent via {@link sendAudioChunk}
   * are ready to be processed. Call this after sending all audio data for a
   * speech segment.
   */
  public commitAudio() {
    this.logger.debug('input_audio_buffer.commit sent to OpenAI');
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  /**
   * Starts the auto-translation timer if configured.
   *
   * This method schedules automatic translation triggering after the specified timeout.
   * If the timer is already running, it will NOT be restarted (to ensure translation happens
   * after the configured time from the first audio chunk).
   */
  private startAutoTranslationTimer() {
    // Don't restart if timer is already running
    if (this.autoTranslationTimer) {
      return;
    }

    // Only start timer if autoTranslationTimeout is configured
    if (this.options.autoTranslationTimeout && this.options.autoTranslationTimeout > 0) {
      this.logger.debug(`[auto-translation] Starting timer for ${this.options.autoTranslationTimeout}ms`);
      this.autoTranslationTimer = setTimeout(() => {
        this.logger.log(`[auto-translation] Triggering translation after ${this.options.autoTranslationTimeout}ms`);
        this.commitAudio();
        this.requestResponse();
        // Reset timer state so it can start again with next audio segment
        this.audioStartTime = 0;
        this.autoTranslationTimer = null;
      }, this.options.autoTranslationTimeout);
    }
  }

  /**
   * Resets the auto-translation timer state.
   *
   * This method clears the timer and resets the audio start time,
   * preparing for the next audio input sequence.
   */
  private resetAutoTranslationTimer() {
    if (this.autoTranslationTimer) {
      clearTimeout(this.autoTranslationTimer);
      this.autoTranslationTimer = null;
    }
    this.audioStartTime = 0;
  }

  /**
   * Updates the session configuration options.
   *
   * This method allows updating configuration parameters like autoTranslationTimeout
   * and silenceDurationMs after the handler has been instantiated.
   *
   * @param opts - Partial configuration options to update
   */
  public updateConfig(opts: Partial<RealtimeSessionOptions>) {
    if (opts.autoTranslationTimeout !== undefined) {
      this.options.autoTranslationTimeout = opts.autoTranslationTimeout;
      this.logger.log(`[config] Auto-translation timeout updated to ${opts.autoTranslationTimeout}ms`);
    }
    if (opts.silenceDurationMs !== undefined) {
      this.options.silenceDurationMs = opts.silenceDurationMs;
      this.logger.log(`[config] Silence duration updated to ${opts.silenceDurationMs}ms`);
      // Send session update to apply new VAD settings
      this.sendSessionCreate();
    }
  }

  /**
   * Closes the WebSocket connection.
   *
   * This method gracefully terminates the connection to OpenAI.
   * Any pending operations will be cancelled.
   */
  public close() {
    this.resetAutoTranslationTimer();
    try {
      this.ws.close();
    } catch (err) {
      console.debug(err);
    }
  }

  /**
   * Determines whether a PCM audio buffer contains audible content.
   *
   * This method calculates the Root Mean Square (RMS) of the audio samples
   * and compares it against a threshold to detect silence vs. actual audio.
   *
   * @param pcmBuffer - The PCM audio buffer to analyze (16-bit samples).
   * @param threshold - The RMS threshold above which audio is considered present.
   *                    A value of 0.01 works well for typical speech detection.
   *                    @default 0.01
   *
   * @returns `true` if the buffer contains audio above the threshold,
   *          `false` if the buffer is silent or below the threshold.
   *
   * @example
   * ```typescript
   * const hasContent = handler.hasAudioContent(audioBuffer);
   * if (hasContent) {
   *   handler.sendAudioChunk(audioBuffer);
   * }
   * ```
   */
  public hasAudioContent(pcmBuffer: Buffer, threshold = 0.01): boolean {
    const rms = this.#calculateRMS(pcmBuffer);
    console.log('RMS:', rms);
    return rms > threshold;
  }

  /**
   * Calculates the Root Mean Square (RMS) value of a PCM audio buffer.
   *
   * RMS is a measure of the magnitude of the audio signal and is commonly
   * used for volume/energy detection in audio processing.
   *
   * @param pcmBuffer - The raw PCM audio buffer containing 16-bit signed samples.
   *
   * @returns The RMS value normalized between 0 and 1.
   */
  #calculateRMS(pcmBuffer: Buffer): number {
    const samples = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.length / 2
    );

    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768; // Normalize to range -1 to 1
      sumSquares += normalized * normalized;
    }

    return Math.sqrt(sumSquares / samples.length);
  }
}
