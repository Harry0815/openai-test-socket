// Setze den Pfad zur ffmpeg Binärdatei
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createWebSocketStream, Server, WebSocket } from 'ws';
import { Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

@WebSocketGateway({
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class SocketIoZweiGateway implements OnGatewayConnection, OnGatewayDisconnect {
  clients = new Map<WebSocket, {
    wss: Duplex,
  }>();

  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SocketIoZweiGateway.name);

  handleConnection(client: any, ...args: any[]) {
    const wss = createWebSocketStream(client, {
      decodeStrings: false
    });

    const p = {
      wss: wss,
    };

    this.clients.set(client, p);
    this.logger.log(`Client mit  createWebSocketStream connected`);
  }

  handleDisconnect(client: any) {
    this.clients.delete(client);
    this.logger.log('Client disconnected');
  }
}
