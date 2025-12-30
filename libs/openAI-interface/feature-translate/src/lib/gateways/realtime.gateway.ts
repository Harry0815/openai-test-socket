
import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { IncomingMessage } from 'node:http';
import { Server, WebSocket } from 'ws';
import { AudioDeltaPayload, OpenAIRealtimeSocketHandler } from '@ai-services/ai-helper';

/**
 * Rate limit configuration: Maximum bytes allowed per client within the rate window.
 * Set to 1MB per minute to prevent abuse and ensure fair resource allocation.
 */
const RATE_LIMIT_BYTES = 1024 * 1024;

/**
 * Rate limit time window in milliseconds (1 minute).
 * After this period, the byte counter resets for each client.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Interface representing the session state for each connected WebSocket client.
 * Tracks the OpenAI handler instance, rate limiting data, and authentication status.
 */
interface ClientSessionState {
  /** Handler instance for communicating with OpenAI's Realtime API */
  openAI: OpenAIRealtimeSocketHandler;
  /** Timestamp marking the start of the current rate limit window */
  rateWindowStart: number;
  /** Total bytes received from the client in the current rate window */
  bytesThisWindow: number;
  /** Whether the client has been successfully authenticated */
  authenticated: boolean;
}

/**
 * WebSocket Gateway for real-time audio translation using OpenAI's Realtime API.
 *
 * This gateway provides a WebSocket endpoint that:
 * - Accepts audio streams from clients in real-time
 * - Forwards audio to OpenAI for simultaneous translation (German to English)
 * - Streams translated audio (TTS) back to connected clients
 * - Implements rate limiting to prevent abuse
 * - Supports optional API key authentication
 *
 * The gateway uses the native WebSocket protocol (ws) and supports both
 * WebSocket and polling transports with CORS enabled for all origins.
 *
 * @example
 * ```typescript
 * // Client-side connection example
 * const ws = new WebSocket('ws://localhost:3000');
 *
 * ws.onopen = () => {
 *   // Send audio chunk
 *   ws.send(JSON.stringify({
 *     type: 'audio.chunk',
 *     data: base64EncodedAudioData
 *   }));
 * };
 *
 * ws.onmessage = (event) => {
 *   const message = JSON.parse(event.data);
 *   if (message.type === 'tts-chunk') {
 *     // Handle translated audio
 *     playAudio(message.data, message.sampleRate);
 *   }
 * };
 * ```
 *
 * @implements {OnGatewayConnection} - Handles new client connections
 * @implements {OnGatewayDisconnect} - Handles client disconnections and cleanup
 */
@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  /**
   * WebSocket server instance provided by NestJS.
   * Used to broadcast messages to all connected clients if needed.
   */
  @WebSocketServer()
  server: Server;

  /**
   * Logger instance for this gateway.
   * Used for logging connection events, errors, and debug information.
   */
  private readonly logger = new Logger(RealtimeGateway.name);

  /**
   * Map storing session state for each connected WebSocket client.
   * Keyed by the WebSocket instance for O(1) lookup performance.
   */
  private readonly sessions = new Map<WebSocket, ClientSessionState>();

  /**
   * Handles new WebSocket client connections.
   *
   * This method performs the following operations:
   * 1. Validates the client's authorization (if enabled)
   * 2. Creates a new OpenAI Realtime handler with translation instructions
   * 3. Establishes connection to OpenAI's audio stream API
   * 4. Sets up event listeners for audio output and errors
   * 5. Initializes the client session state with rate limiting data
   *
   * Upon successful connection, sends a 'ready' message to the client
   * containing rate limit configuration.
   *
   * @param client - The WebSocket client instance
   * @param args - Additional arguments, including the HTTP request object
   *               containing headers for authentication
   *
   * @fires 'ready' - Sent to client upon successful connection
   * @fires 'error' - Sent to client if OpenAI connection fails
   */
  async handleConnection(client: WebSocket, ...args: [IncomingMessage]): Promise<void> {
    const request = args?.[0];
    if (!this.isAuthorized(request)) {
      // Authorization check is currently disabled for development
      // Uncomment the following lines to enable API key validation:
      // this.logger.warn('Unauthorized WebSocket connection attempt rejected');
      // client.close(4401, 'unauthorized');
      // return;
    }

    const openAIHandler = new OpenAIRealtimeSocketHandler({
      instructions:
        'You are a simultaneous interpreter. Translate continuously from German to English. Respond exclusively with the translation, no comments.',
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
    });
    try {
      await openAIHandler.connectToAudioStream();
      this.logger.log('Client connected to realtime gateway');
      client.send(
        JSON.stringify({
          type: 'ready',
          rateLimit: { bytes: RATE_LIMIT_BYTES, windowMs: RATE_LIMIT_WINDOW_MS },
        }),
      );
    } catch (err) {
      this.logger.error('Failed to initialize OpenAI Realtime session', err as Error);
      client.send(JSON.stringify({ type: 'error', reason: 'upstream_unavailable' }));
      client.close(1011, 'upstream unavailable');
    }

    this.sessions.set(client, {
      openAI: openAIHandler,
      authenticated: true,
      bytesThisWindow: 0,
      rateWindowStart: Date.now(),
    });

    openAIHandler.events.on('audio.output', (payload) => this.forwardTts(client, payload));
    openAIHandler.events.on('error', (err) => this.forwardError(client, err));

    client.on('message', (data) => this.handleClientMessage(client, data));
  }

  /**
   * Handles WebSocket client disconnections.
   *
   * Performs cleanup operations:
   * - Closes the associated OpenAI handler connection
   * - Removes the client session from the sessions map
   * - Logs the disconnection event
   *
   * @param client - The WebSocket client that disconnected
   */
  handleDisconnect(client: WebSocket): void {
    const session = this.sessions.get(client);
    session?.openAI?.close();
    this.sessions.delete(client);
    this.logger.log('Client disconnected from realtime gateway');
  }

  /**
   * Processes incoming messages from connected WebSocket clients.
   *
   * Supports the following message types:
   * - 'audio.chunk': Audio data to be forwarded to OpenAI for translation
   * - 'audio.commit': Signal to commit buffered audio for processing
   * - 'response.request': Request a response with optional custom instructions
   * - 'audio' or undefined: Legacy format, treated as audio chunk
   *
   * Messages must be valid JSON. Invalid payloads result in an error response.
   *
   * @param client - The WebSocket client sending the message
   * @param rawData - Raw message data (string or Buffer)
   *
   * @fires 'error' - Sent to client for invalid payloads or unknown message types
   */
  private handleClientMessage(client: WebSocket, rawData: any): void {
    const session = this.sessions.get(client);
    // Authentication check is currently disabled for development
    // Uncomment to enable:
    // if (!session?.authenticated) {
    //   client.close(4401, 'unauthorized');
    //   return;
    // }
    let message: any;
    try {
      const text = typeof rawData === 'string' ? rawData : rawData.toString();
      message = JSON.parse(text);
    } catch {
      this.logger.warn(
        'Please ensure that your client is sending valid JSON payloads. See https://docs.openai.com/docs/guides/realtime-api/overview for more details.',
      );
      this.logger.warn('Invalid payload received from client:', typeof rawData === 'string' ? rawData : rawData.toString());
      client.send(JSON.stringify({ type: 'error', reason: 'invalid_payload' }));
      return;
    }

    switch (message?.type) {
      case 'audio.chunk':
        this.forwardAudioChunk(client, session, message);
        break;
      case 'audio.commit':
        session.openAI.commitAudio();
        break;
      case 'response.request':
        session.openAI.requestResponse(message.instructions);
        break;
      case 'audio':
      case undefined:
        this.logger.warn('Receive chunk Data');
        this.forwardAudioChunk(client, session, message);
        break;
      default:
        client.send(JSON.stringify({ type: 'error', reason: 'unknown_message_type' }));
    }
  }

  /**
   * Forwards an audio chunk from the client to OpenAI for translation.
   *
   * Validates the audio data payload and enforces rate limiting before
   * sending the chunk to OpenAI. The audio data must be base64-encoded.
   *
   * @param client - The WebSocket client that sent the audio
   * @param session - The client's session state containing the OpenAI handler
   * @param message - The message object containing the audio data
   *
   * @fires 'error' - Sent to client if audio data is missing or rate limit exceeded
   */
  private forwardAudioChunk(client: WebSocket, session: ClientSessionState, message: any): void {
    if (!message?.data || typeof message.data !== 'string') {
      client.send(JSON.stringify({ type: 'error', reason: 'missing_audio_data' }));
      return;
    }

    const buffer = message.data;
    if (!this.enforceRateLimit(client, session, buffer.length)) {
      return;
    }

    const bufferArray = Buffer.from(buffer, 'base64');
    this.logger.log(`Received chunk of size ${bufferArray.byteLength} bytes`);

    session.openAI.sendAudioChunk(bufferArray);
  }

  /**
   * Forwards translated audio (TTS) from OpenAI back to the client.
   *
   * Constructs a message containing:
   * - type: 'tts-chunk' to identify the message as translated audio
   * - data: Base64-encoded audio data
   * - format: Audio format (e.g., 'pcm16')
   * - sampleRate: Audio sample rate in Hz
   * - responseId: Unique identifier for tracking the response
   *
   * Only sends data if the client connection is still open.
   *
   * @param client - The WebSocket client to send the audio to
   * @param payload - The audio payload from OpenAI containing base64 data and metadata
   */
  private forwardTts(client: WebSocket, payload: AudioDeltaPayload): void {
    console.log('Forwarding TTS chunk to client:', payload);
    if (client.readyState !== client.OPEN) {
      return;
    }
    const body = {
      type: 'tts-chunk',
      data: payload.base64,
      format: payload.format,
      sampleRate: payload.sampleRate,
      responseId: payload.responseId,
    };

    client.send(JSON.stringify(body));
  }

  /**
   * Forwards error information from OpenAI to the client.
   *
   * Extracts the error message if available, otherwise uses a generic
   * 'upstream_error' reason. Only sends if the client connection is open.
   *
   * @param client - The WebSocket client to notify
   * @param err - The error object from OpenAI
   */
  private forwardError(client: WebSocket, err: unknown): void {
    const reason = err instanceof Error ? err.message : 'upstream_error';
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'error', reason }));
    }
  }

  /**
   * Enforces rate limiting for a client's audio data transmission.
   *
   * Rate limiting is currently disabled for development purposes.
   * When enabled, this method:
   * 1. Resets the byte counter if the rate window has expired
   * 2. Accumulates the size of incoming data
   * 3. Closes the connection if the rate limit is exceeded
   *
   * Rate limit: 1MB per minute (RATE_LIMIT_BYTES / RATE_LIMIT_WINDOW_MS)
   *
   * @param client - The WebSocket client to check
   * @param session - The client's session state containing rate limit data
   * @param size - Size of the incoming data in bytes
   * @returns true if the data can be processed, false if rate limit exceeded
   *
   * @fires 'error' - Sent to client when rate limit is exceeded (when enabled)
   */
  private enforceRateLimit(client: WebSocket, session: ClientSessionState, size: number): boolean {
    // Rate limiting is currently disabled for development
    // Uncomment the following block to enable rate limiting:
    // const now = Date.now();
    // if (now - session.rateWindowStart > RATE_LIMIT_WINDOW_MS) {
    //   session.rateWindowStart = now;
    //   session.bytesThisWindow = 0;
    // }
    //
    // session.bytesThisWindow += size;
    // if (session.bytesThisWindow > RATE_LIMIT_BYTES) {
    //   this.logger.warn('Client exceeded realtime audio rate limit');
    //   client.send(JSON.stringify({ type: 'error', reason: 'rate_limited' }));
    //   client.close(4408, 'rate limit exceeded');
    //   return false;
    // }

    return true;
  }

  /**
   * Validates the authorization of an incoming WebSocket connection.
   *
   * Checks for a valid API key in the 'x-api-key' header of the HTTP
   * upgrade request. The expected key is read from the CLIENT_API_KEY
   * environment variable, defaulting to 'dev-key' for development.
   *
   * Supports both single string and array header values.
   *
   * @param request - The HTTP request object from the WebSocket upgrade
   * @returns true if the provided API key matches the expected key
   */
  private isAuthorized(request?: IncomingMessage): boolean {
    const expectedKey = process.env.CLIENT_API_KEY || 'dev-key';
    const providedKey = request?.headers['x-api-key'];
    if (Array.isArray(providedKey)) {
      return providedKey.includes(expectedKey);
    }
    return providedKey === expectedKey;
  }
}
