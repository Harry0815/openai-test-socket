import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { IncomingMessage } from 'node:http';
import { Server, WebSocket } from 'ws';
import { AudioDeltaPayload, OpenAIRealtimeSocketHandler } from '../helper/OpenAISocketHandler';

const RATE_LIMIT_BYTES = 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

interface ClientSessionState {
  openAI: OpenAIRealtimeSocketHandler;
  rateWindowStart: number;
  bytesThisWindow: number;
  authenticated: boolean;
}

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly sessions = new Map<WebSocket, ClientSessionState>();

  async handleConnection(client: WebSocket, ...args: [IncomingMessage]): Promise<void> {
    const request = args?.[0];
    if (!this.isAuthorized(request)) {
      // this.logger.warn('Unauthorized WebSocket connection attempt rejected');
      // client.close(4401, 'unauthorized');
      // return;
    }

    const openAIHandler = new OpenAIRealtimeSocketHandler({
      instructions:
        "'Du bist ein Simultanübersetzer. Übersetze fortlaufend von Deutsch nach Englisch. Antworte ausschließlich mit der Übersetzung, keine Kommentare.',",
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

  handleDisconnect(client: WebSocket): void {
    const session = this.sessions.get(client);
    session?.openAI?.close();
    this.sessions.delete(client);
    this.logger.log('Client disconnected from realtime gateway');
  }

  private handleClientMessage(client: WebSocket, rawData: any): void {    // WebSocket.RawData
    const session = this.sessions.get(client);
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
      )
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

  private forwardAudioChunk(client: WebSocket, session: ClientSessionState, message: any): void {
    if (!message?.data || typeof message.data !== 'string') {
      client.send(JSON.stringify({ type: 'error', reason: 'missing_audio_data' }));
      return;
    }

    // const buffer = Buffer.from(message.data, 'base64');
    const buffer = message.data;
    if (!this.enforceRateLimit(client, session, buffer.length)) {
      return;
    }

    const bufferArray = Buffer.from(buffer, 'base64');
    // const uint8Array = new Uint8Array(bufferArray.buffer, bufferArray.byteOffset, bufferArray.byteLength);
    this.logger.log(`Received chunk of size ${bufferArray.byteLength} bytes`);
    // console.log(bufferArray);

    session.openAI.sendAudioChunk(bufferArray);
  }

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

  private forwardError(client: WebSocket, err: unknown): void {
    const reason = err instanceof Error ? err.message : 'upstream_error';
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'error', reason }));
    }
  }

  private enforceRateLimit(client: WebSocket, session: ClientSessionState, size: number): boolean {
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
    //
    return true;
  }

  private isAuthorized(request?: IncomingMessage): boolean {
    const expectedKey = process.env.CLIENT_API_KEY || 'dev-key';
    const providedKey = request?.headers['x-api-key'];
    if (Array.isArray(providedKey)) {
      return providedKey.includes(expectedKey);
    }
    return providedKey === expectedKey;
  }
}
