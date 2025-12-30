
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { createWebSocketStream, Server, WebSocket } from 'ws';
import { Logger } from '@nestjs/common';
import { Duplex } from 'node:stream';
import {
  MsgDataFromClient,
  msgDataFromClientSchema,
  msgTypes,
} from '@ai-services/ai-helper';
import { OpenAIRealtimeSocketHandler } from '@ai-services/ai-helper';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { PassThrough } from 'node:stream';

// Configure FFmpeg binary path from the installed package
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * WebSocket Gateway for real-time audio translation using OpenAI's Realtime API.
 *
 * This gateway handles:
 * - WebSocket client connections and disconnections
 * - Audio format conversion from WebM to PCM16 using FFmpeg
 * - Real-time audio streaming to OpenAI for translation
 * - Broadcasting translated audio back to clients
 *
 * @implements {OnGatewayConnection} - Lifecycle hook for new client connections
 * @implements {OnGatewayDisconnect} - Lifecycle hook for client disconnections
 */
@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  /**
   * Map storing client-specific data including WebSocket streams,
   * OpenAI handlers, and audio processing components.
   *
   * Each connected client has its own:
   * - wss: Duplex stream for bidirectional communication
   * - openAIHandler: Handler for OpenAI Realtime API communication
   * - audioConverter: PassThrough stream for FFmpeg audio conversion pipeline
   * - pendingInputChunks: Array tracking chunks sent to OpenAI for latency measurement
   */
  clients = new Map<
    WebSocket,
    {
      wss: Duplex;
      openAIHandler?: OpenAIRealtimeSocketHandler;
      audioConverter?: PassThrough;
      pendingInputChunks: Array<{ sequence: number; receivedAt: number }>;
    }
  >();

  /** WebSocket server instance provided by NestJS */
  @WebSocketServer()
  server: Server;

  /** Logger instance for this gateway */
  private readonly logger = new Logger(WsGateway.name);

  /**
   * Handles new WebSocket client connections.
   *
   * This method sets up the complete audio processing pipeline:
   * 1. Initializes OpenAI Realtime handler for translation
   * 2. Creates FFmpeg process to convert WebM audio to PCM16 format
   * 3. Sets up event listeners for audio output from OpenAI
   * 4. Establishes bidirectional communication stream
   *
   * @param client - The connecting WebSocket client
   * @param args - Additional connection arguments (unused)
   */
  async handleConnection(client: WebSocket, ...args: never[]) {
    // Initialize OpenAI Realtime handler with translation instructions
    const openAIHandler = new OpenAIRealtimeSocketHandler({
      instructions:
        'You are a simultaneous interpreter. Translate everything you receive from German to English.',
    });

    // PassThrough stream to feed audio data into FFmpeg
    const inputStream = new PassThrough();

    // Array to track pending chunks for latency measurement
    const pendingInputChunks: Array<{ sequence: number; receivedAt: number }> =
      [];

    /**
     * FFmpeg audio conversion pipeline configuration:
     * - Input: WebM format (from browser MediaRecorder)
     * - Output: PCM16 signed 16-bit little-endian (required by OpenAI)
     * - Sample rate: 24kHz (OpenAI Realtime API requirement)
     * - Channels: Mono (single channel)
     */
    const ffmpegProcess = ffmpeg(inputStream)
      .inputFormat('webm')
      .audioCodec('pcm_s16le')
      .audioFrequency(24000)
      .audioChannels(1)
      .format('s16le')
      .on('error', (err) => this.logger.error('FFmpeg Error: ' + err.message));

    // Get the output stream from FFmpeg process
    const outputStream = ffmpegProcess.pipe();

    /**
     * Handle converted PCM audio chunks from FFmpeg.
     * Performs voice activity detection (VAD) before sending to OpenAI
     * to filter out silence and reduce unnecessary API calls.
     */
    outputStream.on('data', (pcmChunk: Buffer) => {
      // Check if the chunk contains actual audio content (not just silence/noise)
      const readyToSend = openAIHandler.hasAudioContent(pcmChunk);

      if (readyToSend) {
        // Retrieve telemetry data for latency tracking
        const telemetry = pendingInputChunks.shift();

        if (telemetry) {
          const latency = Date.now() - telemetry.receivedAt;
          this.logger.debug(
            `[latency] seq ${telemetry.sequence}: client→OpenAI ${latency} ms (${pcmChunk.length} bytes)`
          );
        } else {
          this.logger.debug(
            '[latency] PCM chunk without pending telemetry entry'
          );
        }

        if (openAIHandler) {
          this.logger.log(
            `PCM chunk ready to send: ${pcmChunk.length} bytes, readyToSend: ${readyToSend}`
          );
          this.logger.log(`Sending chunk to OpenAI: ${pcmChunk.length} bytes`);

          // Forward the audio chunk to OpenAI for translation
          openAIHandler.sendAudioChunk(pcmChunk);
        }
      }
    });

    // Create a duplex stream wrapper for the WebSocket connection
    const wss = createWebSocketStream(client, {
      decodeStrings: false,
    });

    // Store all client-related data in the clients map
    const p = {
      wss: wss,
      openAIHandler: openAIHandler,
      audioConverter: inputStream,
      pendingInputChunks,
    };

    /**
     * Event listener for audio responses from OpenAI.
     * Receives translated audio in PCM16 format and forwards it to the client.
     */
    openAIHandler.events.on('audio.output', (payload) => {
      this.logger.log(
        `[audio.output] Received from OpenAI - sampleRate: ${payload.sampleRate}, base64 length: ${payload.base64?.length}`
      );

      // Decode base64 audio data for logging purposes
      const audioBuffer = Buffer.from(payload.base64, 'base64');
      this.logger.log(
        `[audio.output] Decoded buffer size: ${audioBuffer.length} bytes`
      );

      // Construct the message payload for the client
      // PCM16 is sent directly without additional conversion
      const message = JSON.stringify({
        type: 'play-data',
        data: payload.base64,
        timestamp: new Date().toISOString(),
        format: 'pcm16',
        sampleRate: payload.sampleRate || 24000,
      });

      this.logger.log(
        `[audio.output] Sending to client: ${message.length} chars`
      );

      // Send translated audio to the client
      wss.write(message);
    });

    /**
     * Event listener for OpenAI error events.
     * Logs any errors that occur during communication with OpenAI.
     */
    openAIHandler.events.on('error', (err) => {
      this.logger.error('OpenAI Error:', err);
    });

    // Establish connection to OpenAI Realtime API
    await openAIHandler.connectToAudioStream();

    // Set up empty data handler to prevent stream backpressure issues
    wss.on('data', () => {
      /* Intentionally empty - data is handled via SubscribeMessage decorators */
    });

    // Register the client in the clients map
    this.clients.set(client, p);
    this.logger.log(`Client connected with createWebSocketStream`);

    // Send welcome message to confirm successful connection
    wss.write('Connected to WebSocket Server!');
  }

  /**
   * Handles WebSocket client disconnections.
   * Cleans up all resources associated with the disconnected client.
   *
   * @param client - The disconnecting WebSocket client
   */
  async handleDisconnect(client: WebSocket) {
    // Remove client from the clients map and clean up resources
    this.clients.delete(client);
    this.logger.log('Client disconnected');
  }

  /**
   * Handles incoming audio data from the client.
   *
   * This method:
   * 1. Validates the incoming message against the schema
   * 2. Decodes the base64-encoded audio chunk
   * 3. Writes the audio data to the FFmpeg conversion pipeline
   * 4. Records telemetry data for latency measurement
   *
   * @param data - The audio data message from the client
   * @param client - The WebSocket client sending the data
   */
  @SubscribeMessage(msgTypes.enum.sound_data_from_client)
  handleSoundDataFromClient(
    @MessageBody() data: MsgDataFromClient,
    @ConnectedSocket() client: WebSocket
  ): void {
    // Validate incoming data against the defined schema
    msgDataFromClientSchema.parse(data);

    // Retrieve client-specific data from the map
    const clientData = this.clients.get(client);

    this.logger.log(
      `Received message: ${data.message} ${data.sequence.toString()}, ${
        data.mimeType
      }, ${data.chunk.length} bytes`
    );

    // Process audio chunk if audio converter is available
    if (clientData?.audioConverter) {
      // Decode base64 audio data to binary buffer
      const buffer = Buffer.from(data.chunk, 'base64');

      // Write audio buffer to FFmpeg input stream for conversion
      clientData.audioConverter.write(buffer);

      // Record telemetry for latency tracking
      clientData.pendingInputChunks.push({
        sequence: data.sequence,
        receivedAt: Date.now(),
      });

      this.logger.debug(
        `[latency] seq ${data.sequence}: chunk queued for FFmpeg (${buffer.length} bytes)`
      );
    }
  }

  /**
   * Handles audio data forwarded from AI services.
   * Currently logs the received data for debugging purposes.
   *
   * @param data - The audio data from AI service
   * @param client - The WebSocket client
   */
  @SubscribeMessage(msgTypes.enum.sound_data_from_ai)
  handleSoundDataFromAi(
    @MessageBody() data: any,
    @ConnectedSocket() client: WebSocket
  ): void {
    this.logger.log(`(1) Received message: ${JSON.stringify(data)}`);
  }

  /**
   * Handles generic text messages from clients.
   * Implements a simple echo functionality for testing purposes.
   *
   * @param data - The message data containing the text to echo
   * @param client - The WebSocket client sending the message
   */
  @SubscribeMessage(msgTypes.enum.message)
  handleMessage(
    @MessageBody() data: any,
    @ConnectedSocket() client: WebSocket
  ): void {
    this.logger.log(`(2) Received message: ${JSON.stringify(data)}`);

    // Echo the message back to the client with timestamp
    this.clients.get(client).wss.write(
      JSON.stringify({
        type: 'response',
        data: `Echo: ${data.message || data}`,
        timestamp: new Date().toISOString(),
      })
    );
  }

  /**
   * Handles broadcast requests from clients.
   * Sends the message to all connected clients.
   *
   * @param data - The message data to broadcast
   */
  @SubscribeMessage(msgTypes.enum.broadcast)
  handleBroadcast(@MessageBody() data: any): void {
    this.logger.log(`Broadcasting message: ${JSON.stringify(data)}`);

    // Iterate through all connected clients and send the broadcast message
    this.server.clients.forEach((client) => {
      // Only send to clients with open connections
      if (client.readyState === WebSocket.OPEN) {
        this.clients.get(client).wss.write(
          JSON.stringify({
            type: 'broadcast',
            data: data.message || data,
            timestamp: new Date().toISOString(),
          })
        );
      }
    });
  }
}
