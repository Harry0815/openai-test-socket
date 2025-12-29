
import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

export interface LiveAudioSession {
  id: string;
  clientId: string;
  startTime: Date;
  isActive: boolean;
  chunkCount: number;
  totalBytes: number;
}

@Injectable()
export class SocketLiveAudioService {
  private readonly logger = new Logger(SocketLiveAudioService.name);
  private activeSessions = new Map<WebSocket, LiveAudioSession>();

  startLiveSession(client:  WebSocket): LiveAudioSession {
    const sessionId = `live_${Date.now()}`;
    const session: LiveAudioSession = {
      id: sessionId,
      clientId: "1",
      startTime: new Date(),
      isActive: true,
      chunkCount: 0,
      totalBytes: 0
    };

    this.activeSessions.set(client, session);
    this.logger.log(`Started live audio session ${sessionId} for client`);

    return session;
  }

  updateSessionStats(client: WebSocket, chunkSize: number): boolean {
    const session = this.activeSessions.get(client);
    if (!session || !session.isActive) {
      return false;
    }

    session.chunkCount++;
    session.totalBytes += chunkSize;

    return true;
  }

  stopLiveSession(client:  WebSocket): LiveAudioSession | null {
    const session = this.activeSessions.get(client);
    if (!session) {
      return null;
    }

    session.isActive = false;
    const duration = (Date.now() - session.startTime.getTime()) / 1000;

    this.logger.log(`Stopped live audio session  ${session.chunkCount} chunks, ${this.formatFileSize(session.totalBytes)}, ${duration.toFixed(2)}s`);

    // Cleanup after a short delay
    setTimeout(() => {
      this.activeSessions.delete(client);
    }, 5000);

    return session;
  }

  getActiveSession(client:  WebSocket): LiveAudioSession | null {
    const session = this.activeSessions.get(client);
    if (session && session.isActive) {
      return session;
    }
    return null;
  }

  getActiveSessions(): LiveAudioSession[] {
    return Array.from(this.activeSessions.values()).filter(s => s.isActive);
  }

  cleanupExpiredSessions(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [sessionId, session] of this.activeSessions.entries()) {
      const age = now - session.startTime.getTime();
      if (age > maxAge) {
        this.activeSessions.delete(sessionId);
        this.logger.log(`Cleaned up expired live session: ${sessionId}`);
      }
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
