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
import * as fs from 'node:fs';
import { WriteStream } from 'node:fs';
import {
  createBrowserToRtcPipeline,
  createRtcToBrowserPipeline,
  DEFAULT_CHUNK_DURATION_MS,
  DEFAULT_RTC_SAMPLE_RATE,
} from '../../lib/audio';

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
    pendingInputChunks: Array<{ sequence: number; receivedAt: number }>,
    pendingAIChunks: Array<{ receivedAt: number }>,
    audioFileStream: WriteStream,
    audioFileName?: string,
    inputFileStream: WriteStream,
    inputFileName?: string,
  }>();

  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OwnWebSocketGateway.name);

  async handleConnection(client: WebSocket, ...args: never[]) {
    const sessionId = Date.now();
    const audioFileName = `./output_${sessionId}.pcm`;
    const audioFileStream = fs.createWriteStream(audioFileName);
    const inputFileName = `./input_${sessionId}.webm`;
    const inputFileStream = fs.createWriteStream(inputFileName);

    // Initialisiere OpenAI Handler für diesen Client
    const openAIHandler = new OpenAIRealtimeSocketHandler({
      instructions: 'Translate the incoming speech to fluent English. Respond only with the translation as audio.',
      inputSampleRate: DEFAULT_RTC_SAMPLE_RATE,
      outputSampleRate: DEFAULT_RTC_SAMPLE_RATE,
    });

    const browserToRtc = createBrowserToRtcPipeline({
      inputFormat: 'webm',
      sampleRate: DEFAULT_RTC_SAMPLE_RATE,
      chunkDurationMs: DEFAULT_CHUNK_DURATION_MS,
    });
    const rtcToBrowser = createRtcToBrowserPipeline({
      outputFormat: 'webm',
      sampleRate: DEFAULT_RTC_SAMPLE_RATE,
      chunkDurationMs: DEFAULT_CHUNK_DURATION_MS,
      jitterBuffer: {
        targetLatencyMs: 40,
        maxLatencyMs: 200,
        flushIntervalMs: 10,
      },
    });
    const pendingInputChunks: Array<{ sequence: number; receivedAt: number }> = [];
    const pendingAIChunks: Array<{ receivedAt: number }> = [];

    // Die konvertierten PCM-Daten an OpenAI senden
    browserToRtc.output.on('data', (pcmChunk: Buffer) => {
      const telemetry = pendingInputChunks.shift();
      if (telemetry) {
        const latency = Date.now() - telemetry.receivedAt;
        this.logger.debug(`[latency] seq ${telemetry.sequence}: client→OpenAI ${latency} ms (${pcmChunk.length} bytes)`);
      } else {
        this.logger.debug('[latency] PCM chunk without pending telemetry entry');
      }
      if (openAIHandler) {
        this.logger.log(`Sending chunk to OpenAI: ${pcmChunk.length} bytes`)

        openAIHandler.sendAudioChunk(pcmChunk);
      }
    });

    // Die konvertierten PCM-Daten an OpenAI senden
    rtcToBrowser.output.on('data', (pcmChunk: Buffer) => {
      const telemetry = pendingAIChunks.shift();
      if (telemetry) {
        const latency = Date.now() - telemetry.receivedAt;
        this.logger.debug(`[latency] AI→client encode ${latency} ms (${pcmChunk.length} bytes)`);
      }
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
      audioConverter: browserToRtc.input,
      audioConverterReverse: rtcToBrowser.input,
      pendingInputChunks,
      pendingAIChunks,
      audioFileStream,
      audioFileName,
      inputFileName,
      inputFileStream
    };

    // Event-Listener für Audio-Antworten von OpenAI
    openAIHandler.events.on('audio.output', (payload) => {
      pendingAIChunks.push({ receivedAt: Date.now() });
      this.logger.log(`Sending AI translation chunk to client`);

      const audioBuffer = Buffer.from(payload.base64, 'base64');

      // In die Datei schreiben
      audioFileStream.write(audioBuffer);

      rtcToBrowser.input.write(Buffer.from(payload.base64, 'base64'));
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
    const clientData = this.clients.get(client);
    // Falls du den Stream im clientData Objekt speicherst (empfohlen), schließe ihn hier:
    clientData.audioFileStream?.end();

    const pcmFile = clientData.audioFileName || './output.pcm';
    const mp3File = pcmFile.replace('.pcm', '.mp3');

    ffmpeg(pcmFile)
      .inputFormat('s16le')
      .audioFrequency(48000)
      .audioChannels(1)
      .save(mp3File)
      .on('end', () => {
        this.logger.log('Umwandlung in MP3 abgeschlossen');
        // Optional: fs.unlinkSync(pcmFile); // Lösche die temporäre PCM Datei
      });

    const inputFile = clientData.inputFileName || './input.webm';
    const inputMp3File = inputFile.replace('.webm', '.mp3');

    ffmpeg(inputFile)
      .inputFormat('webm')
      .audioFrequency(24000)
      .audioChannels(1)
      .save(inputMp3File)
      .on('end', () => {
        this.logger.log('Umwandlung in MP3 abgeschlossen');
        // Optional: fs.unlinkSync(pcmFile); // Lösche die temporäre PCM Datei
      });

    this.clients.delete(client);
    this.logger.log('Client disconnected');
  }

  @SubscribeMessage(msgTypes.enum.sound_data_from_client)
  handleSoundDataFromClient(@MessageBody() data: MsgDataFromClient, @ConnectedSocket() client: WebSocket): void {
    msgDataFromClientSchema.parse(data);
    const clientData = this.clients.get(client);

    this.logger.log(`Received message: ${data.message} ${data.sequence.toString()}, ${data.mimeType}, ${data.chunk.length} bytes`);

    if (clientData?.audioConverter) {
      const buffer = Buffer.from(data.chunk, 'base64');
      clientData.inputFileStream.write(buffer);


      clientData.audioConverter.write(buffer);
      clientData.pendingInputChunks.push({ sequence: data.sequence, receivedAt: Date.now() });
      this.logger.debug(`[latency] seq ${data.sequence}: chunk queued for FFmpeg (${buffer.length} bytes)`);
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
