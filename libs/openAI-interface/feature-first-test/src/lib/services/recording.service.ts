
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';

/**
 * Represents the state and metadata of an active audio recording session.
 *
 * This interface defines all properties tracked during the lifecycle of a recording,
 * from initiation through processing to completion or error states.
 *
 * @example
 * ```typescript
 * const session: RecordingSession = {
 *   id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
 *   client: websocketInstance,
 *   startTime: new Date(),
 *   size: 0,
 *   duration: 0,
 *   chunks: [],
 *   status: 'recording',
 *   audioFormat: 'webm'
 * };
 * ```
 */
export interface RecordingSession {
  /**
   * Unique identifier for the recording session.
   * Generated using UUID v4 to ensure global uniqueness across all sessions.
   */
  id: string;

  /**
   * Reference to the WebSocket client connection associated with this session.
   * Used as the key for session lookup and for sending status updates back to the client.
   */
  client: WebSocket;

  /**
   * Timestamp when the recording session was initiated.
   * Used for calculating recording duration and for session timeout management.
   */
  startTime: Date;

  /**
   * Timestamp when the recording session was stopped.
   * Only populated after {@link AudioRecordingService.stopRecordingSession} is called.
   */
  endTime?: Date;

  /**
   * The final filename of the saved recording.
   * Only populated after successful processing and file creation.
   * Format: `recording_${ISO-timestamp}_${random-suffix}.${extension}`
   */
  filename?: string;

  /**
   * Cumulative size of all received audio data in bytes.
   * Updated incrementally as each audio chunk is added to the session.
   */
  size: number;

  /**
   * Duration of the recording in seconds.
   * Calculated as the difference between endTime and startTime after recording stops.
   */
  duration: number;

  /**
   * Array of audio data chunks received during the recording session.
   * Each chunk is a Buffer containing raw audio data from the client.
   * Cleared after processing to free memory while retaining session metadata.
   */
  chunks: Buffer[];

  /**
   * Current status of the recording session.
   * - `recording`: Actively receiving audio chunks from the client
   * - `processing`: Recording stopped, file is being created/processed
   * - `completed`: Recording successfully saved to disk
   * - `error`: An error occurred during recording or processing
   */
  status: 'recording' | 'processing' | 'completed' | 'error';

  /**
   * The detected or configured audio format for this recording.
   * - `webm`: WebM container format (default from browser MediaRecorder)
   * - `wav`: Waveform Audio File Format (fallback/legacy support)
   */
  audioFormat: 'webm' | 'wav';
}

/**
 * Service for managing audio recording sessions over WebSocket connections.
 *
 * This service provides comprehensive server-side audio recording capabilities,
 * allowing clients to stream audio data which is then assembled and saved as
 * playable audio files. It handles the complete lifecycle of recording sessions
 * from initiation through file storage.
 *
 * ## Key Features
 *
 * - **Session Management**: Create, track, and terminate recording sessions per WebSocket client
 * - **Chunk-Based Recording**: Efficiently collects streaming audio data in chunks
 * - **Format Detection**: Automatically detects WebM format from incoming audio data
 * - **Multi-Format Support**: Saves recordings as WebM (native) or WAV (with header generation)
 * - **Statistics & Monitoring**: Provides recording stats, file listings, and active session counts
 * - **Automatic Cleanup**: Removes expired sessions to prevent memory leaks
 *
 * ## Session Lifecycle
 *
 * 1. **Start**: Client initiates recording via {@link startRecordingSession}
 * 2. **Record**: Audio chunks are added via {@link addAudioChunk}
 * 3. **Stop**: Recording finalized via {@link stopRecordingSession}
 * 4. **Complete**: File saved to disk with metadata retained
 *
 * ## Storage Location
 *
 * Recordings are saved to: `{cwd}/apps/test-socket/src/assets/recordings/`
 *
 * ## Usage Example
 *
 * ```typescript
 * @Injectable()
 * class AudioGateway {
 *   constructor(private recordingService: AudioRecordingService) {}
 *
 *   handleStartRecording(client: WebSocket) {
 *     const session = this.recordingService.startRecordingSession(client);
 *     client.send(JSON.stringify({ event: 'recording-started', sessionId: session.id }));
 *   }
 *
 *   handleAudioData(client: WebSocket, data: Buffer) {
 *     this.recordingService.addAudioChunk(client, data);
 *   }
 *
 *   async handleStopRecording(client: WebSocket) {
 *     const session = await this.recordingService.stopRecordingSession(client);
 *     if (session?.status === 'completed') {
 *       client.send(JSON.stringify({
 *         event: 'recording-complete',
 *         filename: session.filename,
 *         duration: session.duration
 *       }));
 *     }
 *   }
 * }
 * ```
 *
 * ## File Naming Convention
 *
 * Saved files follow the pattern: `recording_{ISO-timestamp}_{suffix}.{ext}`
 * - Timestamp format: `2024-01-15T10-30-45-123Z` (colons/dots replaced with dashes)
 * - Extension: `.webm` for WebM format, `.wav` for WAV format
 *
 * @see RecordingSession - The data structure representing a recording session
 */
@Injectable()
export class AudioRecordingService {
  /**
   * Logger instance for diagnostic output, error reporting, and session lifecycle logging.
   * Uses NestJS Logger with the service class name as the context.
   * @private
   */
  private readonly logger = new Logger(AudioRecordingService.name);

  /**
   * Absolute path to the directory where audio recordings are stored.
   * Resolved relative to the current working directory at service instantiation.
   * @private
   */
  private readonly recordingsDirectory = path.join(process.cwd(), 'apps/test-socket/src/assets/recordings');

  /**
   * In-memory storage for active recording sessions.
   * Maps WebSocket client instances to their corresponding session data.
   * This design ensures O(1) lookup time for all session operations.
   * @private
   */
  private activeSessions = new Map<WebSocket, RecordingSession>();

  /**
   * Creates a new AudioRecordingService instance.
   *
   * Initializes the service and ensures the recordings directory exists.
   * If the directory doesn't exist, it will be created recursively including
   * any necessary parent directories.
   *
   * @remarks
   * The constructor is synchronous but performs filesystem operations.
   * Any errors during directory creation will be thrown.
   */
  constructor() {
    // Create recordings directory if it doesn't exist
    if (!fs.existsSync(this.recordingsDirectory)) {
      fs.mkdirSync(this.recordingsDirectory, { recursive: true });
    }
  }

  /**
   * Initiates a new audio recording session for the specified WebSocket client.
   *
   * Creates a new {@link RecordingSession} with a unique UUID identifier and
   * associates it with the provided WebSocket client. If the client already
   * has an active session, it will be overwritten (previous session data will be lost).
   *
   * @param client - The WebSocket connection instance for which to create the session.
   *                 This serves as the unique key for session lookup and management.
   *
   * @returns The newly created {@link RecordingSession} object containing the session ID,
   *          start time, and initialized properties ready to receive audio chunks.
   *
   * @example
   * ```typescript
   * const session = recordingService.startRecordingSession(clientWebSocket);
   * console.log(`Recording started: ${session.id}`);
   * // Output: "Recording started: a1b2c3d4-e5f6-7890-abcd-ef1234567890"
   * ```
   *
   * @remarks
   * - Session IDs are generated using UUID v4 for guaranteed uniqueness
   * - The default audio format is set to 'webm' (standard browser MediaRecorder output)
   * - Initial size, duration, and chunk array are all initialized to zero/empty
   * - The session status is set to 'recording' immediately
   */
  startRecordingSession(client: WebSocket): RecordingSession {
    const sessionId = uuidv4();
    const session: RecordingSession = {
      id: sessionId,
      client,
      startTime: new Date(),
      size: 0,
      duration: 0,
      chunks: [],
      status: 'recording',
      audioFormat: 'webm' // Browser sends WebM by default
    };

    this.activeSessions.set(client, session);
    this.logger.log(`Started recording session ${sessionId} for client `);

    return session;
  }

  /**
   * Adds an audio data chunk to an active recording session.
   *
   * Appends the provided audio data buffer to the session's chunk array and
   * updates the cumulative size counter. For the first chunk, performs format
   * detection by examining the data for WebM signatures.
   *
   * @param client - The WebSocket client whose session should receive the audio chunk.
   * @param chunkData - The raw audio data buffer to add to the recording.
   *
   * @returns `true` if the chunk was successfully added to the session,
   *          `false` if no active recording session exists for the client
   *          or if the session is not in 'recording' status.
   *
   * @example
   * ```typescript
   * // In WebSocket message handler
   * websocket.on('message', (data) => {
   *   if (data instanceof Buffer) {
   *     const success = recordingService.addAudioChunk(websocket, data);
   *     if (!success) {
   *       console.warn('No active recording session for this client');
   *     }
   *   }
   * });
   * ```
   *
   * @remarks
   * - The first chunk triggers format detection via byte signature analysis
   * - Debug logging includes the first 16 bytes in hexadecimal for format debugging
   * - File size is logged in human-readable format (B, KB, MB, GB)
   * - This method should be called for every audio data message received from the client
   */
  addAudioChunk(client: WebSocket, chunkData: Buffer): boolean {
    const session = this.activeSessions.get(client);
    if (!session || session.status !== 'recording') {
      this.logger.warn(`Invalid session or session not recording:`);
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
        this.logger.log(`Detected WebM format for session`);
      }
    }

    this.logger.debug(`Added chunk to session : ${chunkData.length} bytes (total: ${this.formatFileSize(session.size)})`);
    return true;
  }

  /**
   * Stops an active recording session and saves the recorded audio to disk.
   *
   * This method performs the following operations:
   * 1. Marks the session as 'processing'
   * 2. Concatenates all audio chunks into a single buffer
   * 3. Generates a unique filename with timestamp
   * 4. Saves the audio data to the appropriate file format (WebM or WAV)
   * 5. Calculates recording duration based on start/end timestamps
   * 6. Clears chunk data from memory while retaining session metadata
   *
   * @param client - The WebSocket client whose recording session should be stopped.
   *
   * @returns A Promise that resolves to the completed {@link RecordingSession} object
   *          with final metadata (filename, duration, status), or `null` if no session
   *          exists for the specified client.
   *
   * @example
   * ```typescript
   * const session = await recordingService.stopRecordingSession(clientWebSocket);
   *
   * if (session?.status === 'completed') {
   *   console.log(`Recording saved: ${session.filename}`);
   *   console.log(`Duration: ${session.duration.toFixed(2)} seconds`);
   *   console.log(`Size: ${session.size} bytes`);
   * } else if (session?.status === 'error') {
   *   console.error('Recording failed during processing');
   * }
   * ```
   *
   * @remarks
   * - WebM files are saved directly without conversion (browser-native format)
   * - WAV files include a properly formatted 44-byte header
   * - The session remains in the activeSessions map after completion for potential retrieval
   * - Chunk data is cleared after processing to free memory
   * - Duration is calculated from wall-clock time, not actual audio duration
   */
  async stopRecordingSession(client: WebSocket): Promise<RecordingSession | null> {
    const session = this.activeSessions.get(client);
    if (!session) {
      this.logger.warn(`Session not found: `);
      return null;
    }

    session.endTime = new Date();
    session.status = 'processing';

    this.logger.log(`Stopping recording session : ${session.chunks.length} chunks, ${this.formatFileSize(session.size)}, format: ${session.audioFormat}`);

    try {
      // Combine all chunks into a single buffer
      const totalBuffer = Buffer.concat(session.chunks);

      // Create final file path with proper extension
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      let filename: string;
      let finalPath: string;

      if (session.audioFormat === 'webm') {
        // Save as WebM file directly - browsers can play this natively
        filename = `recording_${timestamp}_12345678.webm`;
        finalPath = path.join(this.recordingsDirectory, filename);
        await this.saveWebMFile(totalBuffer, finalPath);
      } else {
        // Fallback to WAV format (legacy support, rarely used with modern browsers)
        filename = `recording_${timestamp}_12345678.wav`;
        finalPath = path.join(this.recordingsDirectory, filename);
        await this.createWavFile(totalBuffer, finalPath);
      }

      session.filename = filename;
      session.status = 'completed';

      // Calculate duration based on wall-clock time (rough estimate)
      const durationSeconds = (session.endTime.getTime() - session.startTime.getTime()) / 1000;
      session.duration = durationSeconds;

      this.logger.log(`Recording session completed: ${session.filename} (${this.formatFileSize(session.size)}, ${durationSeconds.toFixed(2)}s)`);

      // Clean up session data (keep metadata but remove chunks to save memory)
      session.chunks = [];

      return session;
    } catch (error) {
      this.logger.error(`Error processing recording session:`, error);
      session.status = 'error';
      return session;
    }
  }

  /**
   * Saves raw audio data directly as a WebM file.
   *
   * This method writes the audio buffer to disk without any conversion or header
   * modification, as WebM data from browser MediaRecorder is already properly
   * formatted with all necessary container metadata.
   *
   * @param audioBuffer - The complete WebM audio data buffer to save.
   * @param outputPath - The absolute filesystem path where the file should be written.
   *
   * @returns A Promise that resolves when the file has been successfully written,
   *          or rejects with an error if writing fails.
   *
   * @throws Error if the file cannot be written (permissions, disk space, etc.)
   *
   * @private
   */
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

  /**
   * Creates a WAV audio file with proper header from raw PCM audio data.
   *
   * This method generates a standard 44-byte WAV header and prepends it to the
   * provided audio buffer before writing to disk. The resulting file is compatible
   * with all standard audio players and editing software.
   *
   * ## WAV File Structure Created
   *
   * | Offset | Size | Description |
   * |--------|------|-------------|
   * | 0-3    | 4    | "RIFF" chunk identifier |
   * | 4-7    | 4    | File size minus 8 bytes |
   * | 8-11   | 4    | "WAVE" format identifier |
   * | 12-15  | 4    | "fmt " subchunk identifier |
   * | 16-19  | 4    | Subchunk size (16 for PCM) |
   * | 20-21  | 2    | Audio format (1 = PCM) |
   * | 22-23  | 2    | Number of channels |
   * | 24-27  | 4    | Sample rate |
   * | 28-31  | 4    | Byte rate |
   * | 32-33  | 2    | Block align |
   * | 34-35  | 2    | Bits per sample |
   * | 36-39  | 4    | "data" subchunk identifier |
   * | 40-43  | 4    | Data size |
   * | 44+    | var  | Audio data |
   *
   * @param audioBuffer - The raw PCM audio data (assumed 16-bit mono at 44.1kHz).
   * @param outputPath - The absolute filesystem path where the WAV file should be written.
   *
   * @returns A Promise that resolves when the file has been successfully written,
   *          or rejects with an error if writing fails.
   *
   * @throws Error if the file cannot be created or written.
   *
   * @remarks
   * This method assumes the following audio parameters:
   * - Sample Rate: 44100 Hz
   * - Channels: 1 (Mono)
   * - Bits per Sample: 16
   *
   * This method is kept for potential future use but is rarely called with current
   * browser behavior, as WebM is the standard output format from MediaRecorder.
   *
   * @private
   */
  private async createWavFile(audioBuffer: Buffer, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Audio format parameters (standard CD-quality mono)
      const sampleRate = 44100;
      const channels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * channels * bitsPerSample / 8;
      const blockAlign = channels * bitsPerSample / 8;
      const dataSize = audioBuffer.length;
      const fileSize = 36 + dataSize;

      // Create WAV header (44 bytes total)
      const header = Buffer.alloc(44);
      let offset = 0;

      // RIFF header chunk (12 bytes)
      header.write('RIFF', offset); offset += 4;
      header.writeUInt32LE(fileSize, offset); offset += 4;
      header.write('WAVE', offset); offset += 4;

      // Format subchunk (24 bytes)
      header.write('fmt ', offset); offset += 4;
      header.writeUInt32LE(16, offset); offset += 4; // Subchunk size for PCM
      header.writeUInt16LE(1, offset); offset += 2; // Audio format: 1 = PCM (uncompressed)
      header.writeUInt16LE(channels, offset); offset += 2;
      header.writeUInt32LE(sampleRate, offset); offset += 4;
      header.writeUInt32LE(byteRate, offset); offset += 4;
      header.writeUInt16LE(blockAlign, offset); offset += 2;
      header.writeUInt16LE(bitsPerSample, offset); offset += 2;

      // Data subchunk header (8 bytes)
      header.write('data', offset); offset += 4;
      header.writeUInt32LE(dataSize, offset);

      // Write the complete file using a stream
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

  /**
   * Retrieves the active recording session for a specific WebSocket client.
   *
   * @param client - The WebSocket client whose session should be retrieved.
   *
   * @returns The {@link RecordingSession} for the client if one exists,
   *          or `null` if no session is associated with the client.
   *
   * @example
   * ```typescript
   * const session = recordingService.getRecordingSession(clientWebSocket);
   * if (session) {
   *   console.log(`Session ${session.id}: ${session.status}, ${session.chunks.length} chunks`);
   * }
   * ```
   */
  getRecordingSession(client: WebSocket): RecordingSession | null {
    return this.activeSessions.get(client) || null;
  }

  /**
   * Retrieves a list of all saved recordings from the recordings directory.
   *
   * Scans the recordings directory for WebM and WAV files and returns metadata
   * for each file found, including size, creation date, and format.
   *
   * @returns An array of recording metadata objects sorted by creation date
   *          (newest first). Returns an empty array if no recordings exist
   *          or if an error occurs during directory scanning.
   *
   * @example
   * ```typescript
   * const recordings = recordingService.getAllRecordings();
   * recordings.forEach(recording => {
   *   console.log(`${recording.file}: ${recording.size} bytes, created ${recording.created}`);
   * });
   * ```
   *
   * @remarks
   * - Only files with `.webm` or `.wav` extensions are included
   * - Duration is not calculated as it would require media file parsing
   * - Files are sorted with the most recently created files first
   */
  getAllRecordings(): { file: string; size: number; created: Date; format: string; duration?: number }[] {
    try {
      if (!fs.existsSync(this.recordingsDirectory)) {
        return [];
      }

      const files = fs.readdirSync(this.recordingsDirectory)
        .filter(file => file.match(/\.(webm|wav)$/i)) // Support both WebM and WAV formats
        .map(file => {
          const filePath = path.join(this.recordingsDirectory, file);
          const stats = fs.statSync(filePath);
          const ext = path.extname(file).substring(1).toLowerCase();

          return {
            file,
            size: stats.size,
            created: stats.birthtime,
            format: ext,
            // Note: Duration calculation would require media parsing for WebM - skipped for performance
          };
        })
        .sort((a, b) => b.created.getTime() - a.created.getTime());

      return files;
    } catch (error) {
      this.logger.error('Error reading recordings directory:', error);
      return [];
    }
  }

  /**
   * Deletes a recording file from the recordings directory.
   *
   * Performs security validation to ensure only supported audio files
   * (WebM and WAV) can be deleted, preventing potential path traversal attacks.
   *
   * @param filename - The name of the file to delete (not the full path).
   *
   * @returns A Promise that resolves to `true` if the file was successfully deleted,
   *          or `false` if the file doesn't exist, has an unsupported extension,
   *          or if deletion fails.
   *
   * @example
   * ```typescript
   * const deleted = await recordingService.deleteRecording('recording_2024-01-15T10-30-45-123Z_12345678.webm');
   * if (deleted) {
   *   console.log('Recording deleted successfully');
   * } else {
   *   console.log('Recording not found or could not be deleted');
   * }
   * ```
   *
   * @remarks
   * - Only `.webm` and `.wav` file extensions are allowed for deletion
   * - The filename should be the basename only, not a full path
   * - Attempting to delete files with other extensions will be logged as a warning
   */
  async deleteRecording(filename: string): Promise<boolean> {
    try {
      // Security check - only allow WebM and WAV files to be deleted
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

  /**
   * Resolves a recording filename to its absolute filesystem path.
   *
   * Performs security validation to ensure only supported audio file types
   * can be accessed, preventing potential path traversal or unauthorized file access.
   *
   * @param filename - The name of the recording file (not the full path).
   *
   * @returns The absolute filesystem path to the recording file.
   *
   * @throws Error if the filename does not have a supported extension (.webm or .wav).
   *
   * @example
   * ```typescript
   * try {
   *   const filePath = recordingService.getRecordingFilePath('recording.webm');
   *   const stream = fs.createReadStream(filePath);
   *   // Stream the file to client...
   * } catch (error) {
   *   console.error('Invalid file type requested');
   * }
   * ```
   */
  getRecordingFilePath(filename: string): string {
    // Security check - only allow supported audio file extensions
    if (!filename.match(/\.(webm|wav)$/i)) {
      throw new Error('Only WebM and WAV files are supported');
    }
    return path.join(this.recordingsDirectory, filename);
  }

  /**
   * Removes expired recording sessions from memory.
   *
   * Sessions that have been active for longer than 30 minutes and are not
   * in 'completed' status are considered orphaned and will be removed.
   * This prevents memory leaks from sessions that were never properly terminated.
   *
   * @example
   * ```typescript
   * // Set up periodic cleanup (e.g., every 5 minutes)
   * setInterval(() => {
   *   recordingService.cleanupExpiredSessions();
   * }, 5 * 60 * 1000);
   * ```
   *
   * @remarks
   * - Maximum session age before cleanup: 30 minutes
   * - Completed sessions are not removed by this method
   * - This method should be called periodically via a scheduled task or interval
   * - Consider integrating with NestJS `@Cron` decorator for automated cleanup
   */
  cleanupExpiredSessions(): void {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes maximum session age

    for (const [sessionId, session] of this.activeSessions.entries()) {
      const age = now - session.startTime.getTime();
      if (age > maxAge && session.status !== 'completed') {
        this.activeSessions.delete(sessionId);
        this.logger.log(`Cleaned up expired recording session: ${sessionId}`);
      }
    }
  }

  /**
   * Formats a byte count into a human-readable string with appropriate units.
   *
   * Automatically selects the most appropriate unit (B, KB, MB, or GB) based
   * on the magnitude of the input value.
   *
   * @param bytes - The number of bytes to format.
   *
   * @returns A formatted string with the value and unit (e.g., "1.5 MB", "256 KB").
   *          Returns "0 B" for zero bytes.
   *
   * @example
   * ```typescript
   * formatFileSize(0);          // "0 B"
   * formatFileSize(1024);       // "1 KB"
   * formatFileSize(1536);       // "1.5 KB"
   * formatFileSize(1048576);    // "1 MB"
   * formatFileSize(1073741824); // "1 GB"
   * ```
   *
   * @private
   */
  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Returns the count of currently active recording sessions.
   *
   * @returns The number of active recording sessions across all connected clients.
   *
   * @example
   * ```typescript
   * const activeCount = recordingService.getActiveSessionsCount();
   * console.log(`Currently recording: ${activeCount} sessions`);
   * ```
   */
  getActiveSessionsCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Retrieves comprehensive statistics about all recordings and active sessions.
   *
   * Provides aggregate information useful for monitoring, dashboards, and
   * administrative interfaces.
   *
   * @returns An object containing:
   *          - `totalRecordings`: Total number of saved recording files
   *          - `totalSize`: Combined size of all recordings in bytes
   *          - `averageSize`: Average size per recording in bytes
   *          - `activeSessions`: Number of currently active recording sessions
   *          - `oldestRecording`: Creation date of the oldest recording (if any)
   *          - `newestRecording`: Creation date of the newest recording (if any)
   *
   * @example
   * ```typescript
   * const stats = recordingService.getRecordingStats();
   * console.log(`Total recordings: ${stats.totalRecordings}`);
   * console.log(`Total storage used: ${stats.totalSize} bytes`);
   * console.log(`Average recording size: ${stats.averageSize} bytes`);
   * console.log(`Active sessions: ${stats.activeSessions}`);
   *
   * if (stats.newestRecording) {
   *   console.log(`Latest recording: ${stats.newestRecording.toISOString()}`);
   * }
   * ```
   */
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
