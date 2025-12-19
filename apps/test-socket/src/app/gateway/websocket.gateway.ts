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
import { z } from 'zod';

const msgTypes = z.enum({
  sound_data_from_client: 'sound_data_from_client',
  sound_data_from_ai: 'sound_data_from_ai',
  message: 'message',
  broadcast: 'broadcast',
});

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
  }>();

  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OwnWebSocketGateway.name);

  async handleConnection(client: WebSocket, ...args: never[]) {
    const wss = createWebSocketStream(client, {
      decodeStrings: false
    });
    const p = {
      wss: wss,
    };

    wss.on('data', (buffer) => {
      this.logger.log(`Daten erhalten: ${buffer}`);
    });

    this.clients.set(client, p);
    this.logger.log(`Client mit  createWebSocketStream connected`);

    wss.write('Connected to WebSocket Server!');
  }

  async handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
    this.logger.log('Client disconnected');
  }

  @SubscribeMessage(msgTypes.enum.sound_data_from_client)
  handleSoundDataFromClient(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Received message: ${JSON.stringify(data)}`);

    // Echo die Nachricht zurück an den Client
    this.clients.get(client).wss.write(JSON.stringify({
      type: 'response',
      data: `Echo: ${data.message || data}`,
      timestamp: new Date().toISOString()
    }));
  }

  @SubscribeMessage(msgTypes.enum.sound_data_from_ai)
  handleSoundDataFromAi(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Received message: ${JSON.stringify(data)}`);

    // Echo die Nachricht weiter an den Client

  }

  @SubscribeMessage(msgTypes.enum.message)
  handleMessage(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Received message: ${JSON.stringify(data)}`);

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
