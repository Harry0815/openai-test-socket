
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
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Configure FFmpeg binary path from the installed package
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Socket.IO Gateway for real-time audio streaming and recording functionality.
 *
 * This gateway provides a comprehensive WebSocket interface for:
 * - Audio file streaming with format conversion support
 * - Real-time audio recording from browser clients
 * - Live audio echo/streaming for testing purposes
 * - Basic messaging and broadcast functionality
 *
 * The gateway listens on port 3001 and supports CORS from any origin.
 *
 * @implements {OnGatewayConnection} - Lifecycle hook for handling new client connections
 * @implements {OnGatewayDisconnect} - Lifecycle hook for handling client disconnections
 */
@WebSocketGateway(3001, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['Socket', 'polling'],
})
export class SocketioGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  /** WebSocket server instance provided by NestJS */
  @WebSocketServer()
  server: Server;

  /** Logger instance for this gateway */
  private readonly logger = new Logger(SocketioGateway.name);

  /** Service for managing audio files and streaming */
  private readonly audioService: AudioService = new AudioService();

  /** Service for handling audio recording sessions */
  private readonly audioRecordingService: AudioRecordingService =
    new AudioRecordingService();

  /** Service for managing live audio echo/streaming sessions */
  private readonly liveAudioService: SocketLiveAudioService =
    new SocketLiveAudioService();

  /**
   * Handles new WebSocket client connections.
   *
   * When a client connects, this method:
   * 1. Sends a welcome message to confirm the connection
   * 2. Emits the list of available audio files
   * 3. Emits the list of existing recordings
   *
   * @param client - The connecting WebSocket client instance
   */
  handleConnection(client: WebSocket) {
    this.logger.log(`Client connected`);

    // Send welcome message to confirm successful connection
    client.send(
      JSON.stringify({
        type: 'welcome',
        data: 'Welcome! Connection established.',
      })
    );

    // Emit list of available audio files to the newly connected client
    const audioFiles = this.audioService.getAvailableAudioFiles();
    client.send(JSON.stringify({ type: 'audio-list', data: audioFiles }));

    // Emit list of existing recordings to the newly connected client
    const recordings = this.audioRecordingService.getAllRecordings();
    client.send(JSON.stringify({ type: 'recordings-list', data: recordings }));
  }

  /**
   * Handles WebSocket client disconnections.
   *
   * Performs cleanup operations including:
   * - Stopping any active live audio sessions for the disconnected client
   * - Releasing associated resources
   *
   * @param client - The disconnecting WebSocket client instance
   */
  handleDisconnect(client: WebSocket) {
    this.logger.log(`Client disconnected`);

    // Check for and clean up any active live audio session
    const activeSession = this.liveAudioService.getActiveSession(client);
    if (activeSession) {
      this.liveAudioService.stopLiveSession(client);
      this.logger.log(`Cleaned up live session for disconnected client`);
    }
  }

  // ============================================================================
  // RECORDING MANAGEMENT HANDLERS
  // ============================================================================

  /**
   * Handles requests to start a new audio recording session.
   *
   * Creates a new recording session for the client and returns session details
   * including the unique session ID and start timestamp.
   *
   * @param data - Optional configuration object containing the desired format ('wav' | 'mp3')
   * @param client - The WebSocket client initiating the recording
   *
   * @emits 'recording-started' - On successful session creation with session details
   * @emits 'recording-error' - If session creation fails
   */
  @SubscribeMessage('start-recording')
  handleStartRecording(
    @MessageBody() data: { format?: 'wav' | 'mp3' },
    @ConnectedSocket() client: WebSocket
  ): void {
    this.logger.log(`WAV recording start requested`);

    try {
      const session = this.audioRecordingService.startRecordingSession(client);

      client.send(
        JSON.stringify({
          type: 'recording-started',
          data: {
            sessionId: session.id,
            format: 'wav',
            startTime: session.startTime,
          },
        })
      );

      this.logger.log(`WAV recording session started: ${session.id}`);
    } catch (error) {
      this.logger.error('Error starting WAV recording:', error);
      client.send(
        JSON.stringify({
          type: 'recording-error',
          data: {
            error: 'Failed to start WAV recording',
            details: error.message,
          },
        })
      );
    }
  }

  /**
   * Handles incoming audio chunks during an active recording session.
   *
   * Receives base64-encoded audio data from the client, decodes it,
   * and appends it to the ongoing recording session.
   *
   * @param data - Object containing:
   *   - sessionId: Unique identifier of the recording session
   *   - chunk: Base64-encoded audio data
   *   - sequence: Sequential chunk number for ordering
   * @param client - The WebSocket client sending the audio chunk
   *
   * @emits 'chunk-received' - Acknowledgment of successful chunk processing
   * @emits 'recording-error' - If chunk processing fails
   */
  @SubscribeMessage('audio-chunk')
  handleAudioChunk(
    @MessageBody()
    data: { sessionId: string; chunk: string; sequence: number },
    @ConnectedSocket() client: WebSocket
  ): void {
    const { sessionId, chunk, sequence } = data;

    try {
      // Decode the base64-encoded audio chunk to binary buffer
      const audioBuffer = Buffer.from(chunk, 'base64');

      // Attempt to add the audio chunk to the active recording session
      const success = this.audioRecordingService.addAudioChunk(
        client,
        audioBuffer
      );

      if (success) {
        // Send acknowledgment of successful chunk reception
        client.send(
          JSON.stringify({
            type: 'chunk-received',
            data: {
              sessionId,
              sequence,
            },
          })
        );
      } else {
        client.send(
          JSON.stringify({
            type: 'recording-error',
            data: {
              sessionId,
              error: 'Failed to add audio chunk',
              sequence,
            },
          })
        );
      }
    } catch (error) {
      this.logger.error(
        `Error processing audio chunk for session ${sessionId}:`,
        error
      );
      client.send(
        JSON.stringify({
          type: 'recording-error',
          data: {
            sessionId,
            error: 'Failed to process audio chunk',
            details: error.message,
            sequence,
          },
        })
      );
    }
  }

  /**
   * Handles requests to stop an active recording session.
   *
   * Finalizes the recording, saves the audio file, and returns
   * comprehensive metadata about the completed recording.
   *
   * @param data - Object containing the sessionId to stop
   * @param client - The WebSocket client stopping the recording
   *
   * @emits 'recording-completed' - On successful completion with recording metadata
   * @emits 'recordings-list' - Updated list of all recordings
   * @emits 'recording-error' - If stopping the recording fails
   */
  @SubscribeMessage('stop-recording')
  async handleStopRecording(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() client: WebSocket
  ): Promise<void> {
    const { sessionId } = data;

    this.logger.log(`Recording stop requested for session ${sessionId}`);

    try {
      const session =
        await this.audioRecordingService.stopRecordingSession(client);

      if (session) {
        // Determine the actual format based on the file extension
        const format = session.filename?.endsWith('.webm') ? 'webm' : 'wav';

        client.send(
          JSON.stringify({
            type: 'recording-completed',
            data: {
              sessionId: session.id,
              filename: session.filename,
              format: format,
              size: session.size,
              duration: session.duration,
              status: session.status,
              endTime: session.endTime,
            },
          })
        );

        // Broadcast the updated recordings list to the client
        const recordings = this.audioRecordingService.getAllRecordings();
        client.send(
          JSON.stringify({
            type: 'recordings-list',
            data: { recordings },
          })
        );

        this.logger.log(`Recording completed: ${session.filename} (${format})`);
      } else {
        client.send(
          JSON.stringify({
            type: 'recording-error',
            data: {
              sessionId,
              error: 'Session not found or already stopped',
            },
          })
        );
      }
    } catch (error) {
      this.logger.error(`Error stopping recording ${sessionId}:`, error);
      client.send(
        JSON.stringify({
          type: 'recording-error',
          data: {
            sessionId,
            error: 'Failed to stop recording',
            details: error.message,
          },
        })
      );
    }
  }

  /**
   * Handles requests to retrieve the list of all recordings.
   *
   * @param client - The WebSocket client requesting the recordings list
   *
   * @emits 'recordings-list' - List of all available recordings with metadata
   */
  @SubscribeMessage('get-recordings')
  handleGetRecordings(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Recordings list requested`);

    const recordings = this.audioRecordingService.getAllRecordings();
    client.send(
      JSON.stringify({
        type: 'recordings-list',
        data: {
          recordings,
        },
      })
    );
  }

  /**
   * Handles requests to delete a specific recording.
   *
   * Removes the recording file from storage and broadcasts
   * the updated recordings list to the client.
   *
   * @param data - Object containing the filename of the recording to delete
   * @param client - The WebSocket client requesting the deletion
   *
   * @emits 'recording-deleted' - Confirmation of successful deletion
   * @emits 'recordings-list' - Updated list of remaining recordings
   * @emits 'recording-error' - If deletion fails
   */
  @SubscribeMessage('delete-recording')
  async handleDeleteRecording(
    @MessageBody() data: { filename: string },
    @ConnectedSocket() client: WebSocket
  ): Promise<void> {
    const { filename } = data;

    this.logger.log(`Recording deletion requested: ${filename}`);

    try {
      const success =
        await this.audioRecordingService.deleteRecording(filename);

      if (success) {
        client.send(
          JSON.stringify({
            type: 'recording-deleted',
            data: {
              filename,
            },
          })
        );

        // Broadcast the updated recordings list after deletion
        const recordings = this.audioRecordingService.getAllRecordings();
        client.send(
          JSON.stringify({
            type: 'recordings-list',
            data: {
              recordings,
            },
          })
        );

        this.logger.log(`Recording deleted: ${filename}`);
      } else {
        client.send(
          JSON.stringify({
            type: 'recording-error',
            data: {
              error: 'Failed to delete recording',
              filename,
            },
          })
        );
      }
    } catch (error) {
      this.logger.error(`Error deleting recording ${filename}:`, error);
      client.send(
        JSON.stringify({
          type: 'recording-error',
          data: {
            error: 'Failed to delete recording',
            filename,
            details: error.message,
          },
        })
      );
    }
  }

  /**
   * Handles requests to stream a specific recording file.
   *
   * Streams the recording in chunks to enable playback on the client.
   * Sends metadata first, followed by sequential audio chunks, and
   * finally a completion event.
   *
   * @param data - Object containing the filename of the recording to stream
   * @param client - The WebSocket client requesting the stream
   *
   * @emits 'audio-stream-start' - Stream metadata including file info and chunk size
   * @emits 'audio-chunk' - Sequential audio data chunks (base64 encoded)
   * @emits 'audio-stream-end' - Confirmation of stream completion with statistics
   * @emits 'recording-error' - If streaming fails
   */
  @SubscribeMessage('stream-recording')
  async handleStreamRecording(
    @MessageBody() data: { filename: string },
    @ConnectedSocket() client: WebSocket
  ): Promise<void> {
    const { filename } = data;

    this.logger.log(`Recording stream requested: ${filename}`);

    try {
      const filePath =
        this.audioRecordingService.getRecordingFilePath(filename);

      // Verify the recording file exists before attempting to stream
      if (!fs.existsSync(filePath)) {
        client.send(
          JSON.stringify({
            type: 'recording-error',
            data: {
              error: 'Recording file not found',
              filename,
            },
          })
        );
        return;
      }

      // Stream the audio file and get file statistics
      const chunks = await this.audioService.streamAudioFile(filePath);
      const fileSize = fs.statSync(filePath).size;

      // Emit stream start event with file metadata
      client.send(
        JSON.stringify({
          type: 'audio-stream-start',
          data: {
            fileId: filename,
            fileName: filename,
            format: path.extname(filename).substring(1),
            totalSize: fileSize,
            chunkSize: 64 * 1024,
          },
        })
      );

      // Stream audio chunks sequentially
      let chunkIndex = 0;
      for (const chunk of chunks) {
        client.send(
          JSON.stringify({
            type: 'audio-chunk',
            data: {
              fileId: filename,
              chunkIndex,
              totalChunks: chunks.length,
              data: chunk.toString('base64'),
              isLast: chunkIndex === chunks.length - 1,
            },
          })
        );
        chunkIndex++;

        // Small delay between chunks to prevent overwhelming the client
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Emit stream completion event with final statistics
      client.send(
        JSON.stringify({
          type: 'audio-stream-end',
          data: {
            fileId: filename,
            totalChunks: chunks.length,
            totalSize: fileSize,
          },
        })
      );
    } catch (error) {
      this.logger.error(`Error streaming recording ${filename}:`, error);
      client.send(
        JSON.stringify({
          type: 'recording-error',
          data: {
            error: 'Failed to stream recording',
            filename,
            details: error.message,
          },
        })
      );
    }
  }

  // ============================================================================
  // BASIC MESSAGING HANDLERS
  // ============================================================================

  /**
   * Handles generic text messages from clients.
   *
   * Implements a simple echo functionality that returns the received
   * message back to the client with a timestamp.
   *
   * @param data - The message data object containing the message content
   * @param client - The WebSocket client sending the message
   *
   * @emits 'response' - Echo response with the original message and timestamp
   */
  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: any,
    @ConnectedSocket() client: WebSocket
  ): void {
    this.logger.log(`Received message: ${JSON.stringify(data)}`);

    client.send(
      JSON.stringify({
        type: 'response',
        data: {
          data: `Echo: ${data.message || data}`,
          timestamp: new Date().toISOString(),
          clientId: '',
        },
      })
    );
  }

  /**
   * Handles broadcast requests from clients.
   *
   * Note: Currently sends the broadcast message back only to the
   * requesting client. Full broadcast to all clients would require
   * iterating through the server's client list.
   *
   * @param data - The message data to broadcast
   * @param client - The WebSocket client initiating the broadcast
   *
   * @emits 'broadcast' - The broadcast message with timestamp
   */
  @SubscribeMessage('broadcast')
  handleBroadcast(
    @MessageBody() data: any,
    @ConnectedSocket() client: WebSocket
  ): void {
    this.logger.log(`Broadcasting message: ${JSON.stringify(data)}`);

    client.send(
      JSON.stringify({
        type: 'broadcast',
        data: {
          data: data.message || data,
          timestamp: new Date().toISOString(),
          from: '',
        },
      })
    );
  }

  /**
   * Handles ping requests for connection health checks.
   *
   * Responds with a pong message containing the current server timestamp,
   * allowing clients to measure round-trip latency.
   *
   * @param client - The WebSocket client sending the ping
   *
   * @emits 'pong' - Response with current server timestamp
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Ping received`);
    client.send(
      JSON.stringify({
        type: 'pong',
        data: {
          timestamp: new Date().toISOString(),
        },
      })
    );
  }

  // ============================================================================
  // AUDIO FILE STREAMING HANDLERS
  // ============================================================================

  /**
   * Handles requests to retrieve the list of available audio files.
   *
   * @param client - The WebSocket client requesting the audio list
   *
   * @emits 'audio-list' - List of available audio files with metadata
   */
  @SubscribeMessage('request-audio-list')
  handleRequestAudioList(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Audio list requested`);
    const audioFiles = this.audioService.getAvailableAudioFiles();
    client.send(JSON.stringify({ type: 'audio-list', data: audioFiles }));
  }

  /**
   * Handles requests to stream a specific audio file.
   *
   * Supports automatic format conversion for non-MP3 files using FFmpeg.
   * Files are converted to MP3 format on-the-fly before streaming to ensure
   * browser compatibility.
   *
   * The streaming process:
   * 1. Validates the requested audio file exists
   * 2. For non-MP3 files: converts to MP3 using FFmpeg before streaming
   * 3. Sends stream start event with file metadata
   * 4. Streams audio data in sequential chunks (base64 encoded)
   * 5. Sends stream end event with completion statistics
   *
   * @param data - Object containing:
   *   - fileId: Unique identifier of the audio file to stream
   *   - chunkSize: Optional chunk size in bytes (default: 64KB)
   * @param client - The WebSocket client requesting the stream
   *
   * @emits 'audio-stream-start' - Stream metadata before data transmission
   * @emits 'audio-chunk' - Sequential audio data chunks
   * @emits 'audio-stream-end' - Stream completion confirmation
   * @emits 'audio-error' - If streaming or conversion fails
   */
  @SubscribeMessage('stream-audio')
  async handleStreamAudio(
    @MessageBody() data: { fileId: string; chunkSize?: number },
    @ConnectedSocket() client: WebSocket
  ): Promise<void> {
    const { fileId, chunkSize = 64 * 1024 } = data;
    let chunkIndex = 0;

    this.logger.log(`Audio stream requested: ${fileId}`);

    try {
      const audioFile = this.audioService.getAudioFile(fileId);

      // Validate that the requested audio file exists
      if (!audioFile) {
        client.send(
          JSON.stringify({
            type: 'audio-error',
            data: {
              error: 'Audio file not found',
              fileId,
            },
          })
        );
        return;
      }

      const ext = path.extname(audioFile.path).toLowerCase();
      const fileSize = this.audioService.getFileSize(audioFile.path);

      // Emit stream start event with file metadata
      client.send(
        JSON.stringify({
          type: 'audio-stream-start',
          data: {
            fileId,
            fileName: audioFile.name,
            format: audioFile.format,
            totalSize: fileSize,
            chunkSize,
          },
        })
      );

      // Handle non-MP3 formats by converting to MP3 first
      if (ext !== '.mp3') {
        /**
         * Async function to stream the converted MP3 file after FFmpeg conversion completes.
         * This is called as a callback when FFmpeg finishes the conversion process.
         */
        const streamConvertedFile = async () => {
          const chunks = await this.audioService.streamAudioFile(
            audioFile.convertedPath,
            chunkSize
          );

          // Stream all chunks of the converted file
          for (const chunk of chunks) {
            client.send(
              JSON.stringify({
                type: 'audio-chunk',
                data: {
                  fileId,
                  chunkIndex,
                  totalChunks: chunks.length,
                  data: chunk.toString('base64'),
                  isLast: chunkIndex === chunks.length - 1,
                },
              })
            );
            chunkIndex++;
          }

          // Emit stream completion event
          client.send(
            JSON.stringify({
              type: 'audio-stream-end',
              data: {
                fileId,
                totalChunks: chunks.length,
                totalSize: fileSize,
              },
            })
          );

          this.logger.log(
            `Audio stream completed: ${fileId} (${chunks.length} chunks)`
          );
        };

        /**
         * FFmpeg conversion pipeline configuration:
         * - Codec: libmp3lame (MP3 encoder)
         * - Bitrate: 192 kbps (good quality)
         * - Sample rate: 44.1 kHz (CD quality)
         * - Channels: Stereo (2 channels)
         */
        ffmpeg(audioFile.path)
          .audioCodec('libmp3lame')
          .audioBitrate(192)
          .audioFrequency(44100)
          .audioChannels(2)
          .on('error', (err) =>
            this.logger.error('FFmpeg Error:', err.message)
          )
          .on('end', () => {
            this.logger.log('Format conversion completed');
            streamConvertedFile();
          })
          .save(audioFile.convertedPath);
      } else {
        // Stream MP3 files directly without conversion
        const chunks = await this.audioService.streamAudioFile(
          audioFile.path,
          chunkSize
        );

        for (const chunk of chunks) {
          client.send(
            JSON.stringify({
              type: 'audio-chunk',
              data: {
                fileId,
                chunkIndex,
                totalChunks: chunks.length,
                data: chunk.toString('base64'),
                isLast: chunkIndex === chunks.length - 1,
              },
            })
          );
          chunkIndex++;

          // Small delay between chunks to prevent client buffer overflow
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // Emit stream completion event
        client.send(
          JSON.stringify({
            type: 'audio-stream-end',
            data: {
              fileId,
              totalChunks: chunks.length,
              totalSize: fileSize,
            },
          })
        );

        this.logger.log(
          `Audio stream completed: ${fileId} (${chunks.length} chunks)`
        );
      }
    } catch (error) {
      this.logger.error(`Error streaming audio ${fileId}:`, error);
      client.send(
        JSON.stringify({
          type: 'audio-error',
          data: {
            error: 'Failed to stream audio file',
            fileId,
            details: error.message,
          },
        })
      );
    }
  }

  /**
   * Handles requests to stop audio playback.
   *
   * Sends confirmation that the stop request was received.
   * Note: Actual playback control is handled client-side;
   * this endpoint is for coordination purposes.
   *
   * @param data - Object containing the fileId of the audio to stop
   * @param client - The WebSocket client requesting the stop
   *
   * @emits 'audio-stopped' - Confirmation that stop request was processed
   */
  @SubscribeMessage('stop-audio')
  handleStopAudio(
    @MessageBody() data: { fileId: string },
    @ConnectedSocket() client: WebSocket
  ): void {
    this.logger.log(`Audio stop requested: ${data.fileId}`);
    client.send(
      JSON.stringify({
        type: 'audio-stopped',
        data: {
          fileId: data.fileId,
        },
      })
    );
  }

  // ============================================================================
  // LIVE AUDIO ECHO/STREAMING HANDLERS
  // ============================================================================

  /**
   * Handles requests to start a live audio echo session.
   *
   * Creates a new live audio session that immediately echoes
   * received audio back to the client. Useful for testing
   * audio latency and quality.
   *
   * If the client already has an active session, it will be
   * stopped before creating a new one.
   *
   * @param client - The WebSocket client starting the live session
   *
   * @emits 'live-audio-started' - Session details including ID and start time
   * @emits 'live-audio-error' - If session creation fails
   */
  @SubscribeMessage('start-live-audio')
  handleStartLiveAudio(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Live audio echo start requested`);

    try {
      // Stop any existing session for this client before creating a new one
      const existingSession = this.liveAudioService.getActiveSession(client);
      if (existingSession) {
        this.liveAudioService.stopLiveSession(client);
      }

      const session = this.liveAudioService.startLiveSession(client);

      client.send(
        JSON.stringify({
          type: 'live-audio-started',
          data: {
            sessionId: session.id,
            startTime: session.startTime,
          },
        })
      );

      this.logger.log(`Live audio session started: ${session.id}`);
    } catch (error) {
      this.logger.error('Error starting live audio session:', error);
      client.send(
        JSON.stringify({
          type: 'live-audio-error',
          data: {
            error: 'Failed to start live audio session',
            details: error.message,
          },
        })
      );
    }
  }

  /**
   * Handles incoming live audio chunks during an active echo session.
   *
   * Immediately echoes the received audio chunk back to the client
   * without any processing or storage. This enables real-time
   * audio loopback for testing purposes.
   *
   * Also updates session statistics (chunk count, total bytes)
   * and sends acknowledgment of chunk receipt.
   *
   * @param data - Object containing:
   *   - sessionId: Active session identifier
   *   - chunk: Base64-encoded audio data
   *   - sequence: Sequential chunk number
   *   - emitTime: Optional client-side emission timestamp for latency measurement
   * @param client - The WebSocket client sending the audio chunk
   *
   * @emits 'live-audio-echo' - Immediate echo of the received audio chunk
   * @emits 'live-chunk-received' - Acknowledgment of successful chunk processing
   * @emits 'live-audio-error' - If chunk processing fails
   */
  @SubscribeMessage('live-audio-chunk')
  handleLiveAudioChunk(
    @MessageBody()
    data: {
      sessionId: string;
      chunk: string;
      sequence: number;
      emitTime?: number;
    },
    @ConnectedSocket() client: WebSocket
  ): void {
    const { sessionId, chunk, sequence, emitTime } = data;

    try {
      // Decode base64 audio chunk to calculate byte size for statistics
      const audioBuffer = Buffer.from(chunk, 'base64');

      // Update session statistics with the new chunk
      const success = this.liveAudioService.updateSessionStats(
        client,
        audioBuffer.length
      );

      if (success) {
        // Immediately echo the audio chunk back to the client (no storage)
        client.send(
          JSON.stringify({
            type: 'live-audio-echo',
            data: {
              sessionId,
              chunk,
              sequence,
              emitTime,
            },
          })
        );

        // Send acknowledgment of chunk receipt
        client.send(
          JSON.stringify({
            type: 'live-chunk-received',
            data: {
              sessionId,
              sequence,
            },
          })
        );
      } else {
        client.send(
          JSON.stringify({
            type: 'live-audio-error',
            data: {
              sessionId,
              error: 'Invalid session for live audio chunk',
              sequence,
            },
          })
        );
      }
    } catch (error) {
      this.logger.error(
        `Error processing live audio chunk for session ${sessionId}:`,
        error
      );
      client.send(
        JSON.stringify({
          type: 'live-audio-error',
          data: {
            sessionId,
            error: 'Failed to process live audio chunk',
            details: error.message,
            sequence,
          },
        })
      );
    }
  }

  /**
   * Handles requests to stop a live audio echo session.
   *
   * Terminates the active session and returns comprehensive
   * statistics about the session including duration, chunk count,
   * and total bytes processed.
   *
   * @param data - Object containing the sessionId to stop
   * @param client - The WebSocket client stopping the session
   *
   * @emits 'live-audio-stopped' - Session statistics and confirmation
   * @emits 'live-audio-error' - If session cannot be found or stopped
   */
  @SubscribeMessage('stop-live-audio')
  handleStopLiveAudio(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() client: WebSocket
  ): void {
    const { sessionId } = data;

    this.logger.log(`Live audio stop requested for session ${sessionId}`);

    try {
      const session = this.liveAudioService.stopLiveSession(client);

      if (session) {
        // Calculate session duration in seconds
        const duration = (Date.now() - session.startTime.getTime()) / 1000;

        client.send(
          JSON.stringify({
            type: 'live-audio-stopped',
            data: {
              sessionId: session.id,
              duration: duration,
              chunkCount: session.chunkCount,
              totalBytes: session.totalBytes,
            },
          })
        );

        this.logger.log(
          `Live audio session stopped: ${session.id} (${duration.toFixed(2)}s)`
        );
      } else {
        client.send(
          JSON.stringify({
            type: 'live-audio-error',
            data: {
              sessionId,
              error: 'Session not found or already stopped',
            },
          })
        );
      }
    } catch (error) {
      this.logger.error(
        `Error stopping live audio session ${sessionId}:`,
        error
      );
      client.send(
        JSON.stringify({
          type: 'live-audio-error',
          data: {
            sessionId,
            error: 'Failed to stop live audio session',
            details: error.message,
          },
        })
      );
    }
  }

  /**
   * Handles requests to retrieve all active live audio sessions.
   *
   * Returns a list of all currently active live audio sessions
   * across all connected clients. Useful for monitoring and debugging.
   *
   * @param client - The WebSocket client requesting the session list
   *
   * @emits 'live-sessions-list' - List of all active live audio sessions
   */
  @SubscribeMessage('get-live-sessions')
  handleGetLiveSessions(@ConnectedSocket() client: WebSocket): void {
    this.logger.log(`Live sessions list requested`);

    const sessions = this.liveAudioService.getActiveSessions();
    client.send(
      JSON.stringify({
        type: 'live-sessions-list',
        data: {
          sessions,
        },
      })
    );
  }
}
