
import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';

/**
 * Represents the state and statistics of an active live audio streaming session.
 *
 * This interface defines all the metadata tracked for each live audio session,
 * including identification, timing, and data transfer statistics.
 *
 * @example
 * ```typescript
 * const session: LiveAudioSession = {
 *   id: 'live_1703936400000',
 *   clientId: '1',
 *   startTime: new Date(),
 *   isActive: true,
 *   chunkCount: 0,
 *   totalBytes: 0
 * };
 * ```
 */
export interface LiveAudioSession {
  /**
   * Unique identifier for the session.
   * Generated using the format `live_${timestamp}` where timestamp
   * is the Unix epoch milliseconds when the session was created.
   */
  id: string;

  /**
   * Identifier for the client associated with this session.
   * Currently defaults to "1" but can be extended for multi-client scenarios.
   */
  clientId: string;

  /**
   * Timestamp when the session was initiated.
   * Used to calculate session duration and for timeout management.
   */
  startTime: Date;

  /**
   * Flag indicating whether the session is currently active and accepting data.
   * Set to `false` when the session is stopped, but the session object may
   * remain in memory briefly for cleanup purposes.
   */
  isActive: boolean;

  /**
   * Counter tracking the number of audio chunks received during this session.
   * Incremented each time {@link SocketLiveAudioService.updateSessionStats} is called.
   */
  chunkCount: number;

  /**
   * Cumulative total of bytes received across all audio chunks in this session.
   * Useful for bandwidth monitoring and session statistics reporting.
   */
  totalBytes: number;
}

/**
 * Service for managing live audio streaming sessions over WebSocket connections.
 *
 * This service provides real-time audio echo functionality, allowing clients
 * to stream audio data which is immediately processed and can be echoed back.
 * It maintains session state for each connected WebSocket client and provides
 * comprehensive statistics tracking.
 *
 * ## Key Features
 *
 * - **Session Management**: Create, track, and terminate live audio sessions
 * - **Statistics Tracking**: Monitor chunk counts and total bytes transferred
 * - **Automatic Cleanup**: Expired sessions are automatically removed
 * - **Multi-Client Support**: Each WebSocket client maintains its own independent session
 *
 * ## Session Lifecycle
 *
 * 1. **Start**: Client initiates a session via {@link startLiveSession}
 * 2. **Active**: Audio chunks are processed, stats updated via {@link updateSessionStats}
 * 3. **Stop**: Session terminated via {@link stopLiveSession}
 * 4. **Cleanup**: Session removed from memory after a brief delay (5 seconds)
 *
 * ## Usage Example
 *
 * ```typescript
 * @Injectable()
 * class AudioGateway {
 *   constructor(private liveAudioService: SocketLiveAudioService) {}
 *
 *   handleConnection(client: WebSocket) {
 *     const session = this.liveAudioService.startLiveSession(client);
 *     console.log(`Session started: ${session.id}`);
 *   }
 *
 *   handleAudioChunk(client: WebSocket, chunk: Buffer) {
 *     const success = this.liveAudioService.updateSessionStats(client, chunk.length);
 *     if (success) {
 *       // Process and echo the audio chunk
 *     }
 *   }
 *
 *   handleDisconnect(client: WebSocket) {
 *     const session = this.liveAudioService.stopLiveSession(client);
 *     if (session) {
 *       console.log(`Session ended: ${session.chunkCount} chunks processed`);
 *     }
 *   }
 * }
 * ```
 *
 * ## Memory Management
 *
 * Sessions are stored in a Map keyed by WebSocket instance. When a session is stopped,
 * it remains in memory for 5 seconds to allow for final statistics retrieval before
 * being permanently deleted. Use {@link cleanupExpiredSessions} to remove sessions
 * that have been active for longer than 5 minutes (potential orphaned sessions).
 *
 * @see LiveAudioSession - The data structure representing a session
 */
@Injectable()
export class SocketLiveAudioService {
  /**
   * Logger instance for diagnostic output and session lifecycle logging.
   * Uses NestJS Logger with the service class name as the context.
   * @private
   */
  private readonly logger = new Logger(SocketLiveAudioService.name);

  /**
   * In-memory storage for active audio sessions.
   * Maps WebSocket client instances to their corresponding session data.
   * This design ensures O(1) lookup time for session operations.
   * @private
   */
  private activeSessions = new Map<WebSocket, LiveAudioSession>();

  /**
   * Initiates a new live audio streaming session for the specified client.
   *
   * Creates a new {@link LiveAudioSession} with a unique identifier and
   * associates it with the provided WebSocket client. If the client already
   * has an active session, it will be overwritten.
   *
   * @param client - The WebSocket connection instance for which to create the session.
   *                 This serves as the unique key for session lookup.
   *
   * @returns The newly created {@link LiveAudioSession} object containing
   *          the session ID, start time, and initialized statistics.
   *
   * @example
   * ```typescript
   * const session = liveAudioService.startLiveSession(clientWebSocket);
   * console.log(`New session: ${session.id}`);
   * // Output: "New session: live_1703936400000"
   * ```
   *
   * @remarks
   * - Session IDs are generated using the current timestamp to ensure uniqueness
   * - The `clientId` is currently hardcoded to "1" but can be extended for multi-tenant scenarios
   * - Initial chunk count and total bytes are set to 0
   */
  startLiveSession(client: WebSocket): LiveAudioSession {
    const sessionId = `${uuid()}`;
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

  /**
   * Updates the statistics for an active session when an audio chunk is received.
   *
   * Increments the chunk counter and adds the chunk size to the cumulative
   * byte total for the session associated with the specified client.
   *
   * @param client - The WebSocket client whose session statistics should be updated.
   * @param chunkSize - The size of the received audio chunk in bytes.
   *
   * @returns `true` if the session was found and statistics were successfully updated,
   *          `false` if no active session exists for the client or the session is inactive.
   *
   * @example
   * ```typescript
   * const audioChunk = Buffer.from(rawAudioData);
   * const updated = liveAudioService.updateSessionStats(client, audioChunk.length);
   *
   * if (updated) {
   *   // Continue processing the audio chunk
   *   processAndEcho(audioChunk);
   * } else {
   *   // Session not found or inactive - client should start a new session
   *   console.warn('No active session for client');
   * }
   * ```
   *
   * @remarks
   * This method should be called for every audio chunk received from the client
   * to maintain accurate session statistics.
   */
  updateSessionStats(client: WebSocket, chunkSize: number): boolean {
    const session = this.activeSessions.get(client);
    if (!session || !session.isActive) {
      return false;
    }

    session.chunkCount++;
    session.totalBytes += chunkSize;

    return true;
  }

  /**
   * Terminates an active live audio session for the specified client.
   *
   * Marks the session as inactive and logs final session statistics including
   * the total number of chunks processed, total bytes transferred, and session duration.
   * The session data is retained in memory for 5 seconds after stopping to allow
   * for final statistics retrieval before being permanently removed.
   *
   * @param client - The WebSocket client whose session should be terminated.
   *
   * @returns The terminated {@link LiveAudioSession} object with final statistics,
   *          or `null` if no session exists for the specified client.
   *
   * @example
   * ```typescript
   * const session = liveAudioService.stopLiveSession(clientWebSocket);
   *
   * if (session) {
   *   console.log(`Session ${session.id} ended:`);
   *   console.log(`  - Chunks processed: ${session.chunkCount}`);
   *   console.log(`  - Total data: ${session.totalBytes} bytes`);
   * }
   * ```
   *
   * @remarks
   * - The session's `isActive` flag is set to `false` immediately
   * - Session duration is calculated and logged in seconds
   * - The session is automatically deleted from memory after a 5-second delay
   * - Calling this method multiple times for the same client is safe (returns `null` after first call)
   */
  stopLiveSession(client: WebSocket): LiveAudioSession | null {
    const session = this.activeSessions.get(client);
    if (!session) {
      return null;
    }

    session.isActive = false;
    const duration = (Date.now() - session.startTime.getTime()) / 1000;

    this.logger.log(`Stopped live audio session  ${session.chunkCount} chunks, ${this.formatFileSize(session.totalBytes)}, ${duration.toFixed(2)}s`);

    // Cleanup after a short delay to allow final statistics retrieval
    setTimeout(() => {
      this.activeSessions.delete(client);
    }, 5000);

    return session;
  }

  /**
   * Retrieves the active session for a specific WebSocket client.
   *
   * Returns the session only if it exists and is currently active.
   * Inactive sessions (those that have been stopped) are not returned
   * even if they still exist in memory during the cleanup delay period.
   *
   * @param client - The WebSocket client whose session should be retrieved.
   *
   * @returns The active {@link LiveAudioSession} for the client,
   *          or `null` if no active session exists.
   *
   * @example
   * ```typescript
   * const session = liveAudioService.getActiveSession(clientWebSocket);
   *
   * if (session) {
   *   console.log(`Active session: ${session.id}`);
   *   console.log(`Running for: ${Date.now() - session.startTime.getTime()}ms`);
   * } else {
   *   console.log('No active session for this client');
   * }
   * ```
   */
  getActiveSession(client: WebSocket): LiveAudioSession | null {
    const session = this.activeSessions.get(client);
    if (session && session.isActive) {
      return session;
    }
    return null;
  }

  /**
   * Retrieves all currently active sessions across all connected clients.
   *
   * Filters out any sessions that have been stopped (marked as inactive)
   * but not yet cleaned up from memory.
   *
   * @returns An array of all active {@link LiveAudioSession} objects.
   *          Returns an empty array if no active sessions exist.
   *
   * @example
   * ```typescript
   * const activeSessions = liveAudioService.getActiveSessions();
   *
   * console.log(`Currently active sessions: ${activeSessions.length}`);
   * activeSessions.forEach(session => {
   *   console.log(`  - ${session.id}: ${session.chunkCount} chunks`);
   * });
   * ```
   *
   * @remarks
   * This method is useful for monitoring system load and debugging purposes.
   * Consider calling this periodically for health monitoring dashboards.
   */
  getActiveSessions(): LiveAudioSession[] {
    return Array.from(this.activeSessions.values()).filter(s => s.isActive);
  }

  /**
   * Removes expired sessions that have exceeded the maximum allowed age.
   *
   * Sessions older than 5 minutes are considered expired and are removed
   * from memory. This helps prevent memory leaks from orphaned sessions
   * where clients disconnected unexpectedly without proper cleanup.
   *
   * @example
   * ```typescript
   * // Set up periodic cleanup (e.g., every minute)
   * setInterval(() => {
   *   liveAudioService.cleanupExpiredSessions();
   * }, 60000);
   * ```
   *
   * @remarks
   * - Maximum session age is 5 minutes (300,000 milliseconds)
   * - This method should be called periodically via a scheduled task or interval
   * - Both active and inactive sessions are subject to expiration
   * - Consider integrating with NestJS `@Cron` decorator for automated cleanup
   */
  cleanupExpiredSessions(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [client, session] of this.activeSessions.entries()) {
      const age = now - session.startTime.getTime();
      if (age > maxAge) {
        this.activeSessions.delete(client);
        this.logger.log(`Cleaned up expired live session: ${session.id}`);
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
}
