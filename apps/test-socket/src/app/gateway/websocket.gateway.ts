import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  // Keinen separaten Port angeben - nutzt den Server aus main.ts
  transports: ['websocket'],
})
export class OwnWebSocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OwnWebSocketGateway.name);

  handleConnection(client: WebSocket, ...args: any[]) {
    this.logger.log(`Client connected`);
  }

  handleDisconnect(client: WebSocket) {
    this.logger.log('Client disconnected');
  }

  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Received message: ${JSON.stringify(data)}`);

    // Echo die Nachricht zurück an den Client
    client.send(JSON.stringify({
      type: 'response',
      data: `Echo: ${data.message || data}`,
      timestamp: new Date().toISOString()
    }));
  }

  @SubscribeMessage('broadcast')
  handleBroadcast(@MessageBody() data: any): void {
    this.logger.log(`Broadcasting message: ${JSON.stringify(data)}`);

    // Sende Nachricht an alle verbundenen Clients
    this.server.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'broadcast',
          data: data.message || data,
          timestamp: new Date().toISOString()
        }));
      }
    });
  }
}
