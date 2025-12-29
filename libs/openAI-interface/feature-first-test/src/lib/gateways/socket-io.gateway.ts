import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AudioService } from '../services/audio.service';
import { AudioRecordingService } from '../services/recording.service';
import { SocketLiveAudioService } from '../services/live-audio.service';
import { Server, WebSocket } from 'ws';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
} from '@nestjs/websockets';

@WebSocketGateway(3001, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ['Socket', 'polling'],
})
export class SocketioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SocketioGateway.name);
  private readonly audioService: AudioService = new AudioService();
  private readonly audioRecordingService: AudioRecordingService = new AudioRecordingService();
  private readonly liveAudioService: SocketLiveAudioService = new SocketLiveAudioService();

  handleConnection(client: WebSocket) {

    this.logger.log(`Client connected: `);
    client.send(JSON.stringify({type: 'welcome', data: 'Willkommen! Verbindung hergestellt.' }));

    // emite verfügbare Audio-Dateien
    const audioFiles = this.audioService.getAvailableAudioFiles();
    client.send(JSON.stringify({type: 'audio-list', data: audioFiles}));

    // // emite verfügbare Aufnahmen
    const recordings = this.audioRecordingService.getAllRecordings();
    client.send(JSON.stringify({type:'recordings-list', data: recordings}));
  }

  handleDisconnect(client: WebSocket) {
    this.logger.log(`Client disconnected: `);

    // Stop any active live audio session
    const activeSession = this.liveAudioService.getActiveSession(client);
    if (activeSession) {
      this.liveAudioService.stopLiveSession(client);
      this.logger.log(`Cleaned up live session for disconnected client:`);
    }
  }

  // ... existing message handlers (message, broadcast, ping, etc.) ...

  @SubscribeMessage('start-recording')
  handleStartRecording(@MessageBody() data: { format?: 'wav' | 'mp3' }, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`WAV recording start requested by`);

    try {
      const session = this.audioRecordingService.startRecordingSession(client);

      client.send(
        JSON.stringify({
          type: 'recording-started', data: {
            sessionId: session.id,
            format: 'wav',
            startTime: session.startTime
          }}));

      this.logger.log(`WAV recording session started: ${session.id}`);
    } catch (error) {
      this.logger.error('Error starting WAV recording:', error);
      client.send(
        JSON.stringify({
          type: 'recording-error', data: {
            error: 'Failed to start WAV recording',
            details: error.message
          }}));
    }
  }

  @SubscribeMessage('audio-chunk')
  handleAudioChunk(@MessageBody() data: { sessionId: string, chunk: string, sequence: number }, @ConnectedSocket() client: WebSocket): void {
    const { sessionId, chunk, sequence } = data;

    try {
      // Decode base64 audio chunk
      const audioBuffer = Buffer.from(chunk, 'base64');

      const success = this.audioRecordingService.addAudioChunk(client, audioBuffer);

      if (success) {
        // emit acknowledgment
        client.send(
          JSON.stringify({
            type: 'chunk-received', data: {
              sessionId, sequence,
            }}));
      } else {
        client.send(
          JSON.stringify({
            type: 'recording-error', data: {
              sessionId,
              error: 'Failed to add audio chunk',
              sequence
            }}));
      }
    } catch (error) {
      this.logger.error(`Error processing audio chunk for session ${sessionId}:`, error);
      client.send(
        JSON.stringify({
          type: 'recording-error', data: {
            sessionId,
            error: 'Failed to process audio chunk',
            details: error.message,
            sequence
          }}));
    }
  }

  @SubscribeMessage('stop-recording')
  async handleStopRecording(@MessageBody() data: { sessionId: string }, @ConnectedSocket() client: WebSocket): Promise<void> {
    const { sessionId } = data;

    this.logger.log(`Recording stop requested by for session ${sessionId}`);

    try {
      const session = await this.audioRecordingService.stopRecordingSession(client);

      if (session) {
        // Determine actual format from filename
        const format = session.filename?.endsWith('.webm') ? 'webm' : 'wav';

        client.send(
          JSON.stringify({
            type: 'recording-completed', data: {
              sessionId: session.id,
              filename: session.filename,
              format: format,
              size: session.size,
              duration: session.duration,
              status: session.status,
              endTime: session.endTime
            }}));

        // Broadcast updated recordings list to all clients
        const recordings = this.audioRecordingService.getAllRecordings();
        client.send(
          JSON.stringify({
            type: 'recordings-list', data: { recordings }}));

        this.logger.log(`Recording completed: ${session.filename} (${format})`);
      } else {
        client.send(
          JSON.stringify({
            type: 'recording-error', data: {
              sessionId,
              error: 'Session not found or already stopped'
            }}));
      }
    } catch (error) {
      this.logger.error(`Error stopping recording ${sessionId}:`, error);
      client.send(
        JSON.stringify({
          type: 'recording-error', data: {
            sessionId,
            error: 'Failed to stop recording',
            details: error.message
          }}));
    }
  }

  @SubscribeMessage('get-recordings')
  handleGetRecordings(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Recordings list requested by `);

    const recordings = this.audioRecordingService.getAllRecordings();
    client.send(
      JSON.stringify({
        type: 'recordings-list', data: {
          recordings
        }}));
  }

  @SubscribeMessage('delete-recording')
  async handleDeleteRecording(@MessageBody() data: { filename: string }, @ConnectedSocket() client: WebSocket): Promise<void> {
    const { filename } = data;

    this.logger.log(`Recording deletion requested: ${filename} by `);

    try {
      const success = await this.audioRecordingService.deleteRecording(filename);

      if (success) {
        client.send(
          JSON.stringify({
            type: 'recording-deleted', data: {
              filename
            }}));

        // Broadcast updated recordings list
        const recordings = this.audioRecordingService.getAllRecordings();
        client.send(
          JSON.stringify({
            type: 'recordings-list', data: {
              recordings
            }}));

        this.logger.log(`Recording deleted: ${filename}`);
      } else {
        client.send(
          JSON.stringify({
            type: 'recording-error', data: {
              error: 'Failed to delete recording',
              filename
            }}));
      }
    } catch (error) {
      this.logger.error(`Error deleting recording ${filename}:`, error);
      client.send(
        JSON.stringify({
          type: 'recording-error', data: {
            error: 'Failed to delete recording',
            filename,
            details: error.message
          }}));
    }
  }

  @SubscribeMessage('stream-recording')
  async handleStreamRecording(@MessageBody() data: { filename: string }, @ConnectedSocket() client: WebSocket): Promise<void> {
    const { filename } = data;

    this.logger.log(`Recording stream requested: ${filename} by `);

    try {
      const filePath = this.audioRecordingService.getRecordingFilePath(filename);

      if (!fs.existsSync(filePath)) {
        client.send(
          JSON.stringify({
            type: 'recording-error', data: {
              error: 'Recording file not found',
              filename
            }}));
        return;
      }

      // Use existing streaming logic
      const chunks = await this.audioService.streamAudioFile(filePath);
      const fileSize = fs.statSync(filePath).size;

      // emit stream start
      client.send(
        JSON.stringify({
          type: 'audio-stream-start', data: {
            fileId: filename,
            fileName: filename,
            format: path.extname(filename).substring(1),
            totalSize: fileSize,
            chunkSize: 64 * 1024
          }}));

      // emit chunks
      let chunkIndex = 0;
      for (const chunk of chunks) {
        client.send(JSON.stringify({
          type: 'audio-chunk', data: {
            fileId: filename,
            chunkIndex,
            totalChunks: chunks.length,
            data: chunk.toString('base64'),
            isLast: chunkIndex === chunks.length - 1
          }
        }));
        chunkIndex++;

        // Kleine Pause zwischen Chunks
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Stream ended
      client.send(JSON.stringify({type: 'audio-stream-end', data: {
        fileId: filename,
        totalChunks: chunks.length,
        totalSize: fileSize
      }}));

    } catch (error) {
      this.logger.error(`Error streaming recording ${filename}:`, error);
      client.send(
        JSON.stringify({
          type: 'recording-error', data: {
            error: 'Failed to stream recording',
            filename,
            details: error.message
          }}));
    }
  }

  // ... existing handlers (message, broadcast, ping, stream-audio, etc.) ...
  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Received message from : ${JSON.stringify(data)}`);

    client.send(
      JSON.stringify({
        type: 'response', data: {
          data: `Echo: ${data.message || data}`,
          timestamp: new Date().toISOString(),
          clientId: ''
        }}));
  }

  @SubscribeMessage('broadcast')
  handleBroadcast(@MessageBody() data: any, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Broadcasting message from : ${JSON.stringify(data)}`);

    client.send(
      JSON.stringify({
        type: 'broadcast', data: {
          data: data.message || data,
          timestamp: new Date().toISOString(),
          from: ''
        }}));
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Ping from `);
    client.send(
      JSON.stringify({
        type: 'pong', data: {
          timestamp: new Date().toISOString()
        }}));
  }

  @SubscribeMessage('request-audio-list')
  handleRequestAudioList(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Audio list requested by `);
    const audioFiles = this.audioService.getAvailableAudioFiles();
    client.send(JSON.stringify({type: 'audio-list', data: audioFiles}));
  }

  @SubscribeMessage('stream-audio')
  async handleStreamAudio(@MessageBody() data: { fileId: string, chunkSize?: number }, @ConnectedSocket() client: WebSocket): Promise<void> {
    const { fileId, chunkSize = 64 * 1024 } = data;

    this.logger.log(`Audio stream requested: ${fileId} by client`);

    try {
      const audioFile = this.audioService.getAudioFile(fileId);

      if (!audioFile) {
        client.send(JSON.stringify({type:'audio-error', data: {
          error: 'Audio file not found',
            fileId
        }}));
        return;
      }

      const fileSize = this.audioService.getFileSize(audioFile.path);

      // emite Stream-Start-Event mit Metadaten
      client.send(
        JSON.stringify({
          type: 'audio-stream-start', data: {
            fileId,
            fileName: audioFile.name,
            format: audioFile.format,
            totalSize: fileSize,
            chunkSize
      }}));

      // Stream die Audio-Datei in Chunks
      const chunks = await this.audioService.streamAudioFile(audioFile.path, chunkSize);
      let chunkIndex = 0;
      for (const chunk of chunks) {
        client.send(JSON.stringify({
          type: 'audio-chunk', data: {
            fileId,
            chunkIndex,
            totalChunks: chunks.length,
            data: chunk.toString('base64'),
            isLast: chunkIndex === chunks.length - 1
          }
        }));
        chunkIndex++;

        // Kleine Pause zwischen Chunks um Überlastung zu vermeiden
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Stream beendet
      client.send(JSON.stringify({type: 'audio-stream-end', data: {
          fileId,
          totalChunks: chunks.length,
          totalSize: fileSize
        }}));

      this.logger.log(`Audio stream completed: ${fileId} (${chunks.length} chunks)`);

    } catch (error) {
      this.logger.error(`Error streaming audio ${fileId}:`, error);
      client.send(JSON.stringify({type:'audio-error', data: {
          error: 'Failed to stream audio file',
          fileId,
          details: error.message
        }}));
    }
  }

  @SubscribeMessage('stop-audio')
  handleStopAudio(@MessageBody() data: { fileId: string }, @ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Audio stop requested: ${data.fileId} by client `);
    client.send(
      JSON.stringify({
        type: 'audio-stopped', data: {
          fileId: data.fileId
        }}));
  }

  // Live Audio Echo Methods
  @SubscribeMessage('start-live-audio')
  handleStartLiveAudio(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Live audio echo start requested by `);

    try {
      // Stop any existing session for this client
      const existingSession = this.liveAudioService.getActiveSession(client);
      if (existingSession) {
        this.liveAudioService.stopLiveSession(client);
      }

      const session = this.liveAudioService.startLiveSession(client);

      client.send(
        JSON.stringify({
          type: 'live-audio-started', data: {
            sessionId: session.id,
            startTime: session.startTime
          }}));

      this.logger.log(`Live audio session started: ${session.id}`);
    } catch (error) {
      this.logger.error('Error starting live audio session:', error);
      client.send(JSON.stringify({type:'live-audio-error', data: {
          error: 'Failed to start live audio session',
          details: error.message
        }}));
    }
  }

  @SubscribeMessage('live-audio-chunk')
  handleLiveAudioChunk(@MessageBody() data: { sessionId: string, chunk: string, sequence: number, emitTime?: number }, @ConnectedSocket() client: WebSocket): void {
    const { sessionId, chunk, sequence, emitTime } = data;

    try {
      // Decode base64 audio chunk
      const audioBuffer = Buffer.from(chunk, 'base64');

      // Update session stats
      const success = this.liveAudioService.updateSessionStats(client, audioBuffer.length);

      if (success) {
        // SOFORT zurückstreamen - kein Speichern!
        client.send(
          JSON.stringify({
            type: 'live-audio-echo', data: {
              sessionId,
              chunk,
              sequence,
              emitTime
            }}));

        // Optionally: Acknowledge chunk receipt
        client.send(
          JSON.stringify({
            type: 'live-chunk-received', data: {
              sessionId, sequence
            }}));
      } else {
        client.send(JSON.stringify({type:'live-audio-error', data: {
            sessionId,
            error: 'Invalid session for live audio chunk',
            sequence
          }}));
      }
    } catch (error) {
      this.logger.error(`Error processing live audio chunk for session ${sessionId}:`, error);
      client.send(JSON.stringify({type:'live-audio-error', data: {
          sessionId,
          error: 'Failed to process live audio chunk',
          details: error.message,
          sequence
        }}));
    }
  }

  @SubscribeMessage('stop-live-audio')
  handleStopLiveAudio(@MessageBody() data: { sessionId: string }, @ConnectedSocket() client: WebSocket): void {
    const { sessionId } = data;

    this.logger.log(`Live audio stop requested by for session ${sessionId}`);

    try {
      const session = this.liveAudioService.stopLiveSession(client);

      if (session) {
        const duration = (Date.now() - session.startTime.getTime()) / 1000;

        client.send(
          JSON.stringify({
            type: 'live-audio-stopped', data: {
              sessionId: session.id,
              duration: duration,
              chunkCount: session.chunkCount,
              totalBytes: session.totalBytes
            }}));

        this.logger.log(`Live audio session stopped: ${session.id} (${duration.toFixed(2)}s)`);
      } else {
        client.send(JSON.stringify({type:'live-audio-error', data: {
            sessionId,
            error: 'Session not found or already stopped'
          }}));
      }
    } catch (error) {
      this.logger.error(`Error stopping live audio session ${sessionId}:`, error);
      client.send(JSON.stringify({type:'live-audio-error', data: {
          sessionId,
          error: 'Failed to stop live audio session',
          details: error.message
        }}));
    }
  }

  @SubscribeMessage('get-live-sessions')
  handleGetLiveSessions(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Live sessions list requested by`);

    const sessions = this.liveAudioService.getActiveSessions();
    client.send(
      JSON.stringify({
        type: 'live-sessions-list', data: {
          sessions
        }}));
  }

}
