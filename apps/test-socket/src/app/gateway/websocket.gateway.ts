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
} from '../models/msg.model';
import { OpenAIRealtimeSocketHandler } from '../helper/OpenAISocketHandler';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { PassThrough } from 'node:stream';

// Setze den Pfad zur ffmpeg Binärdatei
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

@WebSocketGateway({
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class OwnWebSocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  clients = new Map<WebSocket, {
    wss: Duplex,
    openAIHandler?: OpenAIRealtimeSocketHandler,
    audioConverter?: PassThrough,
    audioConverterReverse?: PassThrough,
  }>();

  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OwnWebSocketGateway.name);

  async handleConnection(client: WebSocket, ...args: never[]) {

    // Initialisiere OpenAI Handler für diesen Client
    const openAIHandler = new OpenAIRealtimeSocketHandler({
      instructions: 'Translate the incoming speech to fluent English. Respond only with the translation as audio.',
    });

    const inputStream = new PassThrough();
    const inputStreamReverse = new PassThrough();

    // FFmpeg Konfiguration: WebM -> PCM16 (S16LE, 16kHz, Mono)
    const ffmpegProcess = ffmpeg(inputStream)
      .inputFormat('webm')
      .audioCodec('pcm_s16le')
      .audioFrequency(24000)
      // .audioBitrate(16)
      .audioChannels(1)
      .format('s16le')
      .on('error', (err) => this.logger.error('FFmpeg Error: ' + err.message));

    const outputStream = ffmpegProcess.pipe();

    const ffmpegProcessReverse = ffmpeg(inputStreamReverse)
      .inputFormat('s16le')
      // .audioBitrate(16)
      .audioFrequency(24000) // MUSS exakt 24000 sein, wenn OpenAI 24kHz liefert
      .audioChannels(1)
      .audioCodec('libopus')
      .format('webm')
      .outputOptions([
        '-deadline realtime',     // WICHTIG für niedrige Latenz
        '-preset ultrafast',
        '-content_type audio/webm',
        '-cluster_size_limit 2M',
        '-cluster_time_limit 5100',
        '-dash 1'
      ])
      .on('error', (err) => this.logger.error('Output FFmpeg Error: ' + err.message));

    const outputStreamReverse = ffmpegProcessReverse.pipe();

    // Die konvertierten PCM-Daten an OpenAI senden
    outputStream.on('data', (pcmChunk: Buffer) => {
      if (openAIHandler) {
        this.logger.log(`Sending chunk to OpenAI: ${pcmChunk.length} bytes`);
        openAIHandler.sendAudioChunk(pcmChunk);
      }
    });

    // Die konvertierten PCM-Daten an OpenAI senden
    outputStreamReverse.on('data', (pcmChunk: Buffer) => {
      this.logger.log(`Sending chunk to client: ${pcmChunk.length} bytes`);
      wss.write(JSON.stringify({
        type: 'play-data', // Das Frontend erwartet diesen Typ
        data: pcmChunk,
        timestamp: new Date().toISOString(),
        format: 'webm',
        sampleRate: 16000
      }));
    });

    const wss = createWebSocketStream(client, {
      decodeStrings: false
    });
    const p = {
      wss: wss,
      openAIHandler: openAIHandler,
      audioConverter: inputStream,
      audioConverterReverse: inputStreamReverse,
    };

    // Event-Listener für Audio-Antworten von OpenAI
    openAIHandler.events.on('audio.output', (payload) => {
      this.logger.log(`Sending AI translation chunk to client`);
      inputStreamReverse.write(Buffer.from(payload.base64, 'base64'));
      // wss.write(JSON.stringify({
      //   type: 'play-data', // Das Frontend erwartet diesen Typ
      //   data: payload.base64,
      //   timestamp: new Date().toISOString(),
      //   format: 'pcm16',
      //   sampleRate: payload.sampleRate
      // }));
    });

    openAIHandler.events.on('error', (err) => {
      this.logger.error('OpenAI Error:', err);
    });

    // Verbindung zu OpenAI herstellen
    await openAIHandler.connectToAudioStream();


    wss.on('data', () => { /* empty */ });

    this.clients.set(client, p);
    this.logger.log(`Client mit  createWebSocketStream connected`);

    wss.write('Connected to WebSocket Server!');
  }

  async handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
    this.logger.log('Client disconnected');
  }

  @SubscribeMessage(msgTypes.enum.sound_data_from_client)
  handleSoundDataFromClient(@MessageBody() data: MsgDataFromClient, @ConnectedSocket() client: WebSocket): void {
    msgDataFromClientSchema.parse(data);
    const clientData = this.clients.get(client);

    this.logger.log(`Received message: ${data.message} ${data.sequence.toString()}, ${data.mimeType}, ${data.chunk.length} bytes`);

    if (clientData?.audioConverter) {
      // Den Base64 WebM Chunk dekodieren und in den FFmpeg Konverter schreiben
      const buffer = Buffer.from(data.chunk, 'base64');
      clientData.audioConverter.write(buffer);
    }

    // if (clientData?.openAIHandler) {
    //   // Chunk an OpenAI weiterleiten
    //   // WICHTIG: OpenAI Realtime erwartet PCM16 Audio.
    //   // Wenn der Client WebM sendet, muss es serverseitig zu PCM konvertiert werden.
    //   const buffer = Buffer.from(data.chunk, 'base64');
    //   clientData.openAIHandler.sendAudioChunk(buffer);
    //
    //   this.logger.log(`Forwarded chunk ${data.sequence} to OpenAI`);
    // }
    //
    // // Jetzt muß das ganze übersetzt werden aber mit rtc openAI
    //
    // // Echo die Nachricht zurück an den Client
    // this.clients.get(client).wss.write(JSON.stringify({
    //   type: 'play-data',
    //   data: data.chunk,
    //   timestamp: new Date().toISOString()
    // }));
  }

  @SubscribeMessage(msgTypes.enum.sound_data_from_ai)
  handleSoundDataFromAi(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`(1) Received message: ${JSON.stringify(data)}`);

    // Echo die Nachricht weiter an den Client

  }

  @SubscribeMessage(msgTypes.enum.message)
  handleMessage(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`(2) Received message: ${JSON.stringify(data)}`);

    // Echo die Nachricht zurück an den Client
    this.clients.get(client).wss.write(JSON.stringify({
      type: 'response',
      data: `Echo: ${data.message || data}`,
      timestamp: new Date().toISOString()
    }));
  }

  @SubscribeMessage(msgTypes.enum.broadcast)
  handleBroadcast(@MessageBody() data: any): void {
    this.logger.log(`Broadcasting message: ${JSON.stringify(data)}`);

    // Sende Nachricht an alle verbundenen Clients
    this.server.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        this.clients.get(client).wss.write(JSON.stringify({
          type: 'broadcast',
          data: data.message || data,
          timestamp: new Date().toISOString()
        }));
      }
    });
  }
}
