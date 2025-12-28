import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface RecordingSession {
  id: string;
  clientId: string;
  startTime: Date;
  endTime?: Date;
  filename?: string;
  size: number;
  duration: number;
  chunks: Buffer[];
  status: 'recording' | 'processing' | 'completed' | 'error';
  audioFormat: 'webm' | 'wav'; // Track the actual format
}

@Injectable()
export class AudioRecordingService {
  private readonly logger = new Logger(AudioRecordingService.name);
  private readonly recordingsDirectory = path.join(process.cwd(), 'apps/test-socket/src/assets/recordings');
  private activeSessions = new Map<string, RecordingSession>();

  constructor() {
    // Erstelle Verzeichnis falls es nicht existiert
    if (!fs.existsSync(this.recordingsDirectory)) {
      fs.mkdirSync(this.recordingsDirectory, { recursive: true });
    }
  }

  startRecordingSession(clientId: string): RecordingSession {
    const sessionId = uuidv4();
    const session: RecordingSession = {
      id: sessionId,
      clientId,
      startTime: new Date(),
      size: 0,
      duration: 0,
      chunks: [],
      status: 'recording',
      audioFormat: 'webm' // Browser sends WebM by default
    };

    this.activeSessions.set(sessionId, session);
    this.logger.log(`Started recording session ${sessionId} for client ${clientId}`);

    return session;
  }

  addAudioChunk(sessionId: string, chunkData: Buffer): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.status !== 'recording') {
      this.logger.warn(`Invalid session or session not recording: ${sessionId}`);
      return false;
    }

    session.chunks.push(chunkData);
    session.size += chunkData.length;

    // Log first chunk to debug format
    if (session.chunks.length === 1) {
      const firstBytes = Array.from(chunkData.slice(0, 16))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
      this.logger.debug(`First chunk bytes: ${firstBytes}`);

      // Detect actual format from chunk data
      if (chunkData.includes(Buffer.from('webm'))) {
        session.audioFormat = 'webm';
        this.logger.log(`Detected WebM format for session ${sessionId}`);
      }
    }

    this.logger.debug(`Added chunk to session ${sessionId}: ${chunkData.length} bytes (total: ${this.formatFileSize(session.size)})`);
    return true;
  }

  async stopRecordingSession(sessionId: string): Promise<RecordingSession | null> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      this.logger.warn(`Session not found: ${sessionId}`);
      return null;
    }

    session.endTime = new Date();
    session.status = 'processing';

    this.logger.log(`Stopping recording session ${sessionId}: ${session.chunks.length} chunks, ${this.formatFileSize(session.size)}, format: ${session.audioFormat}`);

    try {
      // Combine all chunks into a single buffer
      const totalBuffer = Buffer.concat(session.chunks);

      // Create final file path with proper extension
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      let filename: string;
      let finalPath: string;

      if (session.audioFormat === 'webm') {
        // Save as WebM file directly - browsers can play this
        filename = `recording_${timestamp}_${sessionId.substring(0, 8)}.webm`;
        finalPath = path.join(this.recordingsDirectory, filename);
        await this.saveWebMFile(totalBuffer, finalPath);
      } else {
        // Fallback to WAV (though this path shouldn't be reached with current browser behavior)
        filename = `recording_${timestamp}_${sessionId.substring(0, 8)}.wav`;
        finalPath = path.join(this.recordingsDirectory, filename);
        await this.createWavFile(totalBuffer, finalPath);
      }

      session.filename = filename;
      session.status = 'completed';

      // Calculate duration (rough estimate)
      const durationSeconds = (session.endTime.getTime() - session.startTime.getTime()) / 1000;
      session.duration = durationSeconds;

      this.logger.log(`Recording session ${sessionId} completed: ${session.filename} (${this.formatFileSize(session.size)}, ${durationSeconds.toFixed(2)}s)`);

      // Clean up session data (keep metadata but remove chunks to save memory)
      session.chunks = [];

      return session;
    } catch (error) {
      this.logger.error(`Error processing recording session ${sessionId}:`, error);
      session.status = 'error';
      return session;
    }
  }

  private async saveWebMFile(audioBuffer: Buffer, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Write WebM file directly - no conversion needed
        fs.writeFile(outputPath, audioBuffer, (error) => {
          if (error) {
            this.logger.error(`Error writing WebM file: ${error.message}`);
            reject(error);
          } else {
            this.logger.debug(`WebM file saved: ${outputPath} (${this.formatFileSize(audioBuffer.length)})`);
            resolve();
          }
        });
      } catch (error) {
        this.logger.error(`Error saving WebM file: ${error.message}`);
        reject(error);
      }
    });
  }

  private async createWavFile(audioBuffer: Buffer, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // This method is kept for potential future use but won't be called with WebM data
      const sampleRate = 44100;
      const channels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * channels * bitsPerSample / 8;
      const blockAlign = channels * bitsPerSample / 8;
      const dataSize = audioBuffer.length;
      const fileSize = 36 + dataSize;

      // Create WAV header (44 bytes)
      const header = Buffer.alloc(44);
      let offset = 0;

      // RIFF header (12 bytes)
      header.write('RIFF', offset); offset += 4;
      header.writeUInt32LE(fileSize, offset); offset += 4;
      header.write('WAVE', offset); offset += 4;

      // fmt chunk (24 bytes)
      header.write('fmt ', offset); offset += 4;
      header.writeUInt32LE(16, offset); offset += 4; // fmt chunk size
      header.writeUInt16LE(1, offset); offset += 2; // PCM format
      header.writeUInt16LE(channels, offset); offset += 2;
      header.writeUInt32LE(sampleRate, offset); offset += 4;
      header.writeUInt32LE(byteRate, offset); offset += 4;
      header.writeUInt16LE(blockAlign, offset); offset += 2;
      header.writeUInt16LE(bitsPerSample, offset); offset += 2;

      // data chunk header (8 bytes)
      header.write('data', offset); offset += 4;
      header.writeUInt32LE(dataSize, offset);

      // Write file
      try {
        const writeStream = fs.createWriteStream(outputPath);
        writeStream.write(header);
        writeStream.write(audioBuffer);
        writeStream.end();

        writeStream.on('finish', () => {
          this.logger.debug(`WAV file created: ${outputPath} (${this.formatFileSize(header.length + audioBuffer.length)})`);
          resolve();
        });

        writeStream.on('error', (error) => {
          this.logger.error(`Error writing WAV file: ${error.message}`);
          reject(error);
        });
      } catch (error) {
        this.logger.error(`Error creating WAV file: ${error.message}`);
        reject(error);
      }
    });
  }

  getRecordingSession(sessionId: string): RecordingSession | null {
    return this.activeSessions.get(sessionId) || null;
  }

  getAllRecordings(): { file: string; size: number; created: Date; format: string; duration?: number }[] {
    try {
      if (!fs.existsSync(this.recordingsDirectory)) {
        return [];
      }

      const files = fs.readdirSync(this.recordingsDirectory)
        .filter(file => file.match(/\.(webm|wav)$/i)) // Support both WebM and WAV
        .map(file => {
          const filePath = path.join(this.recordingsDirectory, file);
          const stats = fs.statSync(filePath);
          const ext = path.extname(file).substring(1).toLowerCase();

          return {
            file,
            size: stats.size,
            created: stats.birthtime,
            format: ext,
            // Duration calculation would require media parsing for WebM - skip for now
          };
        })
        .sort((a, b) => b.created.getTime() - a.created.getTime());

      return files;
    } catch (error) {
      this.logger.error('Error reading recordings directory:', error);
      return [];
    }
  }

  async deleteRecording(filename: string): Promise<boolean> {
    try {
      // Security check - allow WebM and WAV files
      if (!filename.match(/\.(webm|wav)$/i)) {
        this.logger.warn(`Attempted to delete unsupported file: ${filename}`);
        return false;
      }

      const filePath = path.join(this.recordingsDirectory, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.log(`Recording deleted: ${filename}`);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`Error deleting recording ${filename}:`, error);
      return false;
    }
  }

  getRecordingFilePath(filename: string): string {
    // Security check
    if (!filename.match(/\.(webm|wav)$/i)) {
      throw new Error('Only WebM and WAV files are supported');
    }
    return path.join(this.recordingsDirectory, filename);
  }

  cleanupExpiredSessions(): void {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, session] of this.activeSessions.entries()) {
      const age = now - session.startTime.getTime();
      if (age > maxAge && session.status !== 'completed') {
        this.activeSessions.delete(sessionId);
        this.logger.log(`Cleaned up expired recording session: ${sessionId}`);
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

  getActiveSessionsCount(): number {
    return this.activeSessions.size;
  }

  getRecordingStats(): {
    totalRecordings: number;
    totalSize: number;
    averageSize: number;
    activeSessions: number;
    oldestRecording?: Date;
    newestRecording?: Date;
  } {
    const recordings = this.getAllRecordings();
    const totalSize = recordings.reduce((sum, r) => sum + r.size, 0);

    return {
      totalRecordings: recordings.length,
      totalSize,
      averageSize: recordings.length > 0 ? totalSize / recordings.length : 0,
      activeSessions: this.getActiveSessionsCount(),
      oldestRecording: recordings.length > 0 ? recordings[recordings.length - 1].created : undefined,
      newestRecording: recordings.length > 0 ? recordings[0].created : undefined
    };
  }
}
