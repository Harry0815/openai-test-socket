import * as fs from 'fs';
import * as path from 'path';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { OwnAudioService } from '../services/audio.service';
import { AudioRecordingService } from '../services/recording.service';
import { SocketLiveAudioService } from '../services/live-audio.service';

@WebSocketGateway({
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class SocketioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SocketioGateway.name);
  private readonly audioService: OwnAudioService = new OwnAudioService();
  private readonly audioRecordingService: AudioRecordingService = new AudioRecordingService();
  private readonly liveAudioService: SocketLiveAudioService = new SocketLiveAudioService();

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    client.emit('welcome', { message: 'Willkommen! Verbindung hergestellt.' });

    // Sende verfügbare Audio-Dateien
    const audioFiles = this.audioService.getAvailableAudioFiles();
    client.emit('audio-list', audioFiles);

    // Sende verfügbare Aufnahmen
    const recordings = this.audioRecordingService.getAllRecordings();
    client.emit('recordings-list', recordings);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Stop any active live audio session
    const activeSession = this.liveAudioService.getActiveSession(client.id);
    if (activeSession) {
      this.liveAudioService.stopLiveSession(activeSession.id);
      this.logger.log(`Cleaned up live session for disconnected client: ${client.id}`);
    }
  }

  // ... existing message handlers (message, broadcast, ping, etc.) ...

  @SubscribeMessage('start-recording')
  handleStartRecording(@MessageBody() data: { format?: 'wav' | 'mp3' }, @ConnectedSocket() client: Socket): void {
    this.logger.log(`WAV recording start requested by ${client.id}`);

    try {
      const session = this.audioRecordingService.startRecordingSession(client.id);

      client.emit('recording-started', {
        sessionId: session.id,
        format: 'wav',
        startTime: session.startTime
      });

      this.logger.log(`WAV recording session started: ${session.id}`);
    } catch (error) {
      this.logger.error('Error starting WAV recording:', error);
      client.emit('recording-error', {
        error: 'Failed to start WAV recording',
        details: error.message
      });
    }
  }

  @SubscribeMessage('audio-chunk')
  handleAudioChunk(@MessageBody() data: { sessionId: string, chunk: string, sequence: number }, @ConnectedSocket() client: Socket): void {
    const { sessionId, chunk, sequence } = data;

    try {
      // Decode base64 audio chunk
      const audioBuffer = Buffer.from(chunk, 'base64');

      const success = this.audioRecordingService.addAudioChunk(sessionId, audioBuffer);

      if (success) {
        // Send acknowledgment
        client.emit('chunk-received', { sessionId, sequence });
      } else {
        client.emit('recording-error', {
          sessionId,
          error: 'Failed to add audio chunk',
          sequence
        });
      }
    } catch (error) {
      this.logger.error(`Error processing audio chunk for session ${sessionId}:`, error);
      client.emit('recording-error', {
        sessionId,
        error: 'Failed to process audio chunk',
        details: error.message,
        sequence
      });
    }
  }

  @SubscribeMessage('stop-recording')
  async handleStopRecording(@MessageBody() data: { sessionId: string }, @ConnectedSocket() client: Socket): Promise<void> {
    const { sessionId } = data;

    this.logger.log(`Recording stop requested by ${client.id} for session ${sessionId}`);

    try {
      const session = await this.audioRecordingService.stopRecordingSession(sessionId);

      if (session) {
        // Determine actual format from filename
        const format = session.filename?.endsWith('.webm') ? 'webm' : 'wav';

        client.emit('recording-completed', {
          sessionId: session.id,
          filename: session.filename,
          format: format,
          size: session.size,
          duration: session.duration,
          status: session.status,
          endTime: session.endTime
        });

        // Broadcast updated recordings list to all clients
        const recordings = this.audioRecordingService.getAllRecordings();
        this.server.emit('recordings-list', recordings);

        this.logger.log(`Recording completed: ${session.filename} (${format})`);
      } else {
        client.emit('recording-error', {
          sessionId,
          error: 'Session not found or already stopped'
        });
      }
    } catch (error) {
      this.logger.error(`Error stopping recording ${sessionId}:`, error);
      client.emit('recording-error', {
        sessionId,
        error: 'Failed to stop recording',
        details: error.message
      });
    }
  }

  @SubscribeMessage('get-recordings')
  handleGetRecordings(@ConnectedSocket() client: Socket): void {
    this.logger.log(`Recordings list requested by ${client.id}`);

    const recordings = this.audioRecordingService.getAllRecordings();
    client.emit('recordings-list', recordings);
  }

  @SubscribeMessage('delete-recording')
  async handleDeleteRecording(@MessageBody() data: { filename: string }, @ConnectedSocket() client: Socket): Promise<void> {
    const { filename } = data;

    this.logger.log(`Recording deletion requested: ${filename} by ${client.id}`);

    try {
      const success = await this.audioRecordingService.deleteRecording(filename);

      if (success) {
        client.emit('recording-deleted', { filename });

        // Broadcast updated recordings list
        const recordings = this.audioRecordingService.getAllRecordings();
        this.server.emit('recordings-list', recordings);

        this.logger.log(`Recording deleted: ${filename}`);
      } else {
        client.emit('recording-error', {
          error: 'Failed to delete recording',
          filename
        });
      }
    } catch (error) {
      this.logger.error(`Error deleting recording ${filename}:`, error);
      client.emit('recording-error', {
        error: 'Failed to delete recording',
        filename,
        details: error.message
      });
    }
  }

  @SubscribeMessage('stream-recording')
  async handleStreamRecording(@MessageBody() data: { filename: string }, @ConnectedSocket() client: Socket): Promise<void> {
    const { filename } = data;

    this.logger.log(`Recording stream requested: ${filename} by ${client.id}`);

    try {
      const filePath = this.audioRecordingService.getRecordingFilePath(filename);

      if (!fs.existsSync(filePath)) {
        client.emit('recording-error', {
          error: 'Recording file not found',
          filename
        });
        return;
      }

      // Use existing streaming logic
      const chunks = await this.audioService.streamAudioFile(filePath);
      const fileSize = fs.statSync(filePath).size;

      // Send stream start
      client.emit('audio-stream-start', {
        fileId: filename,
        fileName: filename,
        format: path.extname(filename).substring(1),
        totalSize: fileSize,
        chunkSize: 64 * 1024
      });

      // Send chunks
      let chunkIndex = 0;
      for (const chunk of chunks) {
        client.emit('audio-chunk', {
          fileId: filename,
          chunkIndex,
          totalChunks: chunks.length,
          data: chunk.toString('base64'),
          isLast: chunkIndex === chunks.length - 1
        });
        chunkIndex++;

        // Kleine Pause zwischen Chunks
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Stream ended
      client.emit('audio-stream-end', {
        fileId: filename,
        totalChunks: chunks.length,
        totalSize: fileSize
      });

    } catch (error) {
      this.logger.error(`Error streaming recording ${filename}:`, error);
      client.emit('recording-error', {
        error: 'Failed to stream recording',
        filename,
        details: error.message
      });
    }
  }

  // ... existing handlers (message, broadcast, ping, stream-audio, etc.) ...
  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: any, @ConnectedSocket() client: Socket): void {
    this.logger.log(`Received message from ${client.id}: ${JSON.stringify(data)}`);

    client.emit('response', {
      type: 'response',
      data: `Echo: ${data.message || data}`,
      timestamp: new Date().toISOString(),
      clientId: client.id
    });
  }

  @SubscribeMessage('broadcast')
  handleBroadcast(@MessageBody() data: any, @ConnectedSocket() client: Socket): void {
    this.logger.log(`Broadcasting message from ${client.id}: ${JSON.stringify(data)}`);

    this.server.emit('broadcast', {
      type: 'broadcast',
      data: data.message || data,
      timestamp: new Date().toISOString(),
      from: client.id
    });
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    this.logger.log(`Ping from ${client.id}`);
    client.emit('pong', { timestamp: new Date().toISOString() });
  }

  @SubscribeMessage('request-audio-list')
  handleRequestAudioList(@ConnectedSocket() client: Socket): void {
    this.logger.log(`Audio list requested by ${client.id}`);
    const audioFiles = this.audioService.getAvailableAudioFiles();
    client.emit('audio-list', audioFiles);
  }

  @SubscribeMessage('stream-audio')
  async handleStreamAudio(@MessageBody() data: { fileId: string, chunkSize?: number }, @ConnectedSocket() client: Socket): Promise<void> {
    const { fileId, chunkSize = 64 * 1024 } = data;

    this.logger.log(`Audio stream requested: ${fileId} by client ${client.id}`);

    try {
      const audioFile = this.audioService.getAudioFile(fileId);

      if (!audioFile) {
        client.emit('audio-error', { error: 'Audio file not found', fileId });
        return;
      }

      const fileSize = this.audioService.getFileSize(audioFile.path);

      // Sende Stream-Start-Event mit Metadaten
      client.emit('audio-stream-start', {
        fileId,
        fileName: audioFile.name,
        format: audioFile.format,
        totalSize: fileSize,
        chunkSize
      });

      // Stream die Audio-Datei in Chunks
      const chunks = await this.audioService.streamAudioFile(audioFile.path, chunkSize);

      let chunkIndex = 0;
      for (const chunk of chunks) {
        client.emit('audio-chunk', {
          fileId,
          chunkIndex,
          totalChunks: chunks.length,
          data: chunk.toString('base64'),
          isLast: chunkIndex === chunks.length - 1
        });
        chunkIndex++;

        // Kleine Pause zwischen Chunks um Überlastung zu vermeiden
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Stream beendet
      client.emit('audio-stream-end', {
        fileId,
        totalChunks: chunks.length,
        totalSize: fileSize
      });

      this.logger.log(`Audio stream completed: ${fileId} (${chunks.length} chunks)`);

    } catch (error) {
      this.logger.error(`Error streaming audio ${fileId}:`, error);
      client.emit('audio-error', {
        error: 'Failed to stream audio file',
        fileId,
        details: error.message
      });
    }
  }

  @SubscribeMessage('stop-audio')
  handleStopAudio(@MessageBody() data: { fileId: string }, @ConnectedSocket() client: Socket): void {
    this.logger.log(`Audio stop requested: ${data.fileId} by client ${client.id}`);
    client.emit('audio-stopped', { fileId: data.fileId });
  }

  // Live Audio Echo Methods
  @SubscribeMessage('start-live-audio')
  handleStartLiveAudio(@ConnectedSocket() client: Socket): void {
    this.logger.log(`Live audio echo start requested by ${client.id}`);

    try {
      // Stop any existing session for this client
      const existingSession = this.liveAudioService.getActiveSession(client.id);
      if (existingSession) {
        this.liveAudioService.stopLiveSession(existingSession.id);
      }

      const session = this.liveAudioService.startLiveSession(client.id);

      client.emit('live-audio-started', {
        sessionId: session.id,
        startTime: session.startTime
      });

      this.logger.log(`Live audio session started: ${session.id}`);
    } catch (error) {
      this.logger.error('Error starting live audio session:', error);
      client.emit('live-audio-error', {
        error: 'Failed to start live audio session',
        details: error.message
      });
    }
  }

  @SubscribeMessage('live-audio-chunk')
  handleLiveAudioChunk(@MessageBody() data: { sessionId: string, chunk: string, sequence: number, sendTime?: number }, @ConnectedSocket() client: Socket): void {
    const { sessionId, chunk, sequence, sendTime } = data;

    try {
      // Decode base64 audio chunk
      const audioBuffer = Buffer.from(chunk, 'base64');

      // Update session stats
      const success = this.liveAudioService.updateSessionStats(sessionId, audioBuffer.length);

      if (success) {
        // SOFORT zurückstreamen - kein Speichern!
        client.emit('live-audio-echo', {
          sessionId,
          chunk,
          sequence,
          sendTime
        });

        // Optionally: Acknowledge chunk receipt
        client.emit('live-chunk-received', { sessionId, sequence });
      } else {
        client.emit('live-audio-error', {
          sessionId,
          error: 'Invalid session for live audio chunk',
          sequence
        });
      }
    } catch (error) {
      this.logger.error(`Error processing live audio chunk for session ${sessionId}:`, error);
      client.emit('live-audio-error', {
        sessionId,
        error: 'Failed to process live audio chunk',
        details: error.message,
        sequence
      });
    }
  }

  @SubscribeMessage('stop-live-audio')
  handleStopLiveAudio(@MessageBody() data: { sessionId: string }, @ConnectedSocket() client: Socket): void {
    const { sessionId } = data;

    this.logger.log(`Live audio stop requested by ${client.id} for session ${sessionId}`);

    try {
      const session = this.liveAudioService.stopLiveSession(sessionId);

      if (session) {
        const duration = (Date.now() - session.startTime.getTime()) / 1000;

        client.emit('live-audio-stopped', {
          sessionId: session.id,
          duration: duration,
          chunkCount: session.chunkCount,
          totalBytes: session.totalBytes
        });

        this.logger.log(`Live audio session stopped: ${session.id} (${duration.toFixed(2)}s)`);
      } else {
        client.emit('live-audio-error', {
          sessionId,
          error: 'Session not found or already stopped'
        });
      }
    } catch (error) {
      this.logger.error(`Error stopping live audio session ${sessionId}:`, error);
      client.emit('live-audio-error', {
        sessionId,
        error: 'Failed to stop live audio session',
        details: error.message
      });
    }
  }

  @SubscribeMessage('get-live-sessions')
  handleGetLiveSessions(@ConnectedSocket() client: Socket): void {
    this.logger.log(`Live sessions list requested by ${client.id}`);

    const sessions = this.liveAudioService.getActiveSessions();
    client.emit('live-sessions-list', sessions);
  }

}
