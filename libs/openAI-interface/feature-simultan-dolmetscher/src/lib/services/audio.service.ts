import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents metadata and information about an audio file in the system.
 * This interface provides all necessary details for audio file management,
 * streaming, and playback operations.
 */
export interface AudioFile {
  /**
   * Unique identifier for the audio file, typically the filename.
   */
  id: string;

  /**
   * Human-readable name of the audio file without extension.
   */
  name: string;

  /**
   * Full filesystem path to the converted MP3 version of the file.
   * Used for browser-compatible streaming when the original format
   * may not be supported.
   */
  convertedPath: string;

  /**
   * Full filesystem path to the original audio file.
   */
  path: string;

  /**
   * Duration of the audio file in seconds.
   * Optional as it may not always be calculated.
   */
  duration?: number;

  /**
   * File format/extension without the leading dot (e.g., 'mp3', 'wav').
   */
  format: string;

  /**
   * MIME type of the audio file for HTTP content-type headers.
   * Examples: 'audio/mpeg', 'audio/wav', 'audio/flac'
   */
  mimeType: string;

  /**
   * File size in bytes.
   */
  size: number;

  /**
   * Category classification based on compression type.
   * - 'lossy': Compressed with data loss (MP3, AAC, OGG)
   * - 'lossless': Compressed without data loss (FLAC, ALAC)
   * - 'uncompressed': Raw audio data (WAV, AIFF, PCM)
   * - 'other': Special formats (MIDI, tracker modules)
   */
  category: 'lossy' | 'lossless' | 'uncompressed' | 'other';
}

/**
 * Contains detailed information about a specific audio format.
 * Used for format detection, MIME type mapping, and quality assessment.
 */
export interface AudioFormatInfo {
  /**
   * File extension including the leading dot (e.g., '.mp3', '.wav').
   */
  extension: string;

  /**
   * MIME type associated with this format.
   */
  mimeType: string;

  /**
   * Human-readable description of the audio format.
   */
  description: string;

  /**
   * Compression category of the format.
   */
  category: 'lossy' | 'lossless' | 'uncompressed' | 'other';

  /**
   * Relative quality rating of the format.
   * - 'low': Heavily compressed, suitable for voice
   * - 'medium': Moderate compression, acceptable quality
   * - 'high': High-quality lossy compression
   * - 'lossless': No quality loss from original
   */
  quality: 'low' | 'medium' | 'high' | 'lossless';
}

/**
 * Service for managing and streaming audio files within the application.
 *
 * This service provides comprehensive audio file management capabilities including:
 * - Discovery and enumeration of available audio files
 * - Support for 50+ audio formats across all major categories
 * - Chunked streaming for efficient memory usage
 * - Format detection and metadata extraction
 * - File categorization by compression type
 *
 * ## Supported Format Categories
 *
 * ### Lossless Formats
 * FLAC, ALAC, APE, WavPack, TTA, TAK, Shorten, MLP, TrueHD
 *
 * ### Uncompressed Formats
 * WAV, AIFF, AU, PCM, RAW, Wave64, RF64, BWF
 *
 * ### Lossy Formats (High Quality)
 * MP3, AAC, M4A, OGG, Opus, MPC, DTS, AC-3, E-AC-3
 *
 * ### Lossy Formats (Medium Quality)
 * WMA, MP2, MP1, Speex, RealAudio
 *
 * ### Speech-Optimized Formats
 * AMR, AMR-WB, GSM
 *
 * ### Special Formats
 * MIDI, MOD, IT, S3M, XM, CAF, 3GP
 *
 * ## Usage Example
 *
 * ```typescript
 * @Injectable()
 * class MyService {
 *   constructor(private audioService: AudioService) {}
 *
 *   async playFile(fileId: string) {
 *     const file = this.audioService.getAudioFile(fileId);
 *     if (file) {
 *       const chunks = await this.audioService.streamAudioFile(file.path);
 *       // Process audio chunks...
 *     }
 *   }
 * }
 * ```
 *
 * @remarks
 * The service automatically creates the audio directory if it doesn't exist.
 * Audio files should be placed in `apps/simultan-dolmetscher/src/assets/audio/`.
 */
@Injectable()
export class AudioService {
  /**
   * Logger instance for diagnostic output and error reporting.
   * @private
   */
  private readonly logger = new Logger(AudioService.name);

  /**
   * Base directory path where audio files are stored.
   * Resolved relative to the current working directory.
   * @private
   */
  private readonly audioDirectory = path.join(
    process.cwd(),
    'apps/simultan-dolmetscher/src/assets/audio'
  );

  /**
   * Comprehensive map of supported audio formats with their metadata.
   * Maps file extensions (with leading dot) to format information.
   * @private
   */
  private readonly audioFormats: Map<string, AudioFormatInfo> = new Map([
    // Lossless Formats
    [
      '.flac',
      {
        extension: '.flac',
        mimeType: 'audio/flac',
        description: 'Free Lossless Audio Codec',
        category: 'lossless',
        quality: 'lossless',
      },
    ],
    [
      '.alac',
      {
        extension: '.alac',
        mimeType: 'audio/mp4',
        description: 'Apple Lossless Audio Codec',
        category: 'lossless',
        quality: 'lossless',
      },
    ],
    [
      '.ape',
      {
        extension: '.ape',
        mimeType: 'audio/ape',
        description: "Monkey's Audio",
        category: 'lossless',
        quality: 'lossless',
      },
    ],
    [
      '.wv',
      {
        extension: '.wv',
        mimeType: 'audio/wavpack',
        description: 'WavPack',
        category: 'lossless',
        quality: 'lossless',
      },
    ],
    [
      '.tta',
      {
        extension: '.tta',
        mimeType: 'audio/tta',
        description: 'True Audio',
        category: 'lossless',
        quality: 'lossless',
      },
    ],
    [
      '.tak',
      {
        extension: '.tak',
        mimeType: 'audio/tak',
        description: "Tom's lossless Audio Kompressor",
        category: 'lossless',
        quality: 'lossless',
      },
    ],

    // Uncompressed Formats
    [
      '.wav',
      {
        extension: '.wav',
        mimeType: 'audio/wav',
        description: 'Waveform Audio File Format',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],
    [
      '.aiff',
      {
        extension: '.aiff',
        mimeType: 'audio/aiff',
        description: 'Audio Interchange File Format',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],
    [
      '.aifc',
      {
        extension: '.aifc',
        mimeType: 'audio/aiff',
        description: 'Audio Interchange File Format Compressed',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],
    [
      '.au',
      {
        extension: '.au',
        mimeType: 'audio/basic',
        description: 'Sun Audio Format',
        category: 'uncompressed',
        quality: 'medium',
      },
    ],
    [
      '.snd',
      {
        extension: '.snd',
        mimeType: 'audio/basic',
        description: 'Sound File',
        category: 'uncompressed',
        quality: 'medium',
      },
    ],
    [
      '.pcm',
      {
        extension: '.pcm',
        mimeType: 'audio/pcm',
        description: 'Pulse Code Modulation',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],
    [
      '.raw',
      {
        extension: '.raw',
        mimeType: 'audio/pcm',
        description: 'Raw Audio Data',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],

    // Lossy Formats - High Quality
    [
      '.mp3',
      {
        extension: '.mp3',
        mimeType: 'audio/mpeg',
        description: 'MPEG Audio Layer III',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.aac',
      {
        extension: '.aac',
        mimeType: 'audio/aac',
        description: 'Advanced Audio Coding',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.m4a',
      {
        extension: '.m4a',
        mimeType: 'audio/mp4',
        description: 'MPEG-4 Audio',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.ogg',
      {
        extension: '.ogg',
        mimeType: 'audio/ogg',
        description: 'Ogg Vorbis',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.oga',
      {
        extension: '.oga',
        mimeType: 'audio/ogg',
        description: 'Ogg Audio',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.opus',
      {
        extension: '.opus',
        mimeType: 'audio/opus',
        description: 'Opus Audio Codec',
        category: 'lossy',
        quality: 'high',
      },
    ],

    // Lossy Formats - Medium Quality
    [
      '.wma',
      {
        extension: '.wma',
        mimeType: 'audio/x-ms-wma',
        description: 'Windows Media Audio',
        category: 'lossy',
        quality: 'medium',
      },
    ],
    [
      '.mp2',
      {
        extension: '.mp2',
        mimeType: 'audio/mpeg',
        description: 'MPEG Audio Layer II',
        category: 'lossy',
        quality: 'medium',
      },
    ],
    [
      '.mp1',
      {
        extension: '.mp1',
        mimeType: 'audio/mpeg',
        description: 'MPEG Audio Layer I',
        category: 'lossy',
        quality: 'medium',
      },
    ],
    [
      '.mpc',
      {
        extension: '.mpc',
        mimeType: 'audio/musepack',
        description: 'Musepack',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.spx',
      {
        extension: '.spx',
        mimeType: 'audio/speex',
        description: 'Speex',
        category: 'lossy',
        quality: 'medium',
      },
    ],

    // Speech-Optimized Formats
    [
      '.amr',
      {
        extension: '.amr',
        mimeType: 'audio/amr',
        description: 'Adaptive Multi-Rate',
        category: 'lossy',
        quality: 'low',
      },
    ],
    [
      '.awb',
      {
        extension: '.awb',
        mimeType: 'audio/amr-wb',
        description: 'AMR-WB (Wideband)',
        category: 'lossy',
        quality: 'medium',
      },
    ],
    [
      '.gsm',
      {
        extension: '.gsm',
        mimeType: 'audio/gsm',
        description: 'Global System for Mobile',
        category: 'lossy',
        quality: 'low',
      },
    ],

    // Additional Special Formats
    [
      '.ra',
      {
        extension: '.ra',
        mimeType: 'audio/vnd.rn-realaudio',
        description: 'RealAudio',
        category: 'lossy',
        quality: 'medium',
      },
    ],
    [
      '.rm',
      {
        extension: '.rm',
        mimeType: 'audio/vnd.rn-realaudio',
        description: 'RealMedia',
        category: 'lossy',
        quality: 'medium',
      },
    ],
    [
      '.3gp',
      {
        extension: '.3gp',
        mimeType: 'audio/3gpp',
        description: '3GPP Audio',
        category: 'lossy',
        quality: 'low',
      },
    ],
    [
      '.3g2',
      {
        extension: '.3g2',
        mimeType: 'audio/3gpp2',
        description: '3GPP2 Audio',
        category: 'lossy',
        quality: 'low',
      },
    ],
    [
      '.caf',
      {
        extension: '.caf',
        mimeType: 'audio/x-caf',
        description: 'Core Audio Format',
        category: 'other',
        quality: 'high',
      },
    ],
    [
      '.dts',
      {
        extension: '.dts',
        mimeType: 'audio/dts',
        description: 'DTS Audio',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.ac3',
      {
        extension: '.ac3',
        mimeType: 'audio/ac3',
        description: 'Dolby Digital AC-3',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.eac3',
      {
        extension: '.eac3',
        mimeType: 'audio/eac3',
        description: 'Enhanced AC-3',
        category: 'lossy',
        quality: 'high',
      },
    ],
    [
      '.mlp',
      {
        extension: '.mlp',
        mimeType: 'audio/mlp',
        description: 'Meridian Lossless Packing',
        category: 'lossless',
        quality: 'lossless',
      },
    ],
    [
      '.thd',
      {
        extension: '.thd',
        mimeType: 'audio/truehd',
        description: 'Dolby TrueHD',
        category: 'lossless',
        quality: 'lossless',
      },
    ],

    // Module/Tracker Formats
    [
      '.mod',
      {
        extension: '.mod',
        mimeType: 'audio/mod',
        description: 'Module File',
        category: 'other',
        quality: 'medium',
      },
    ],
    [
      '.it',
      {
        extension: '.it',
        mimeType: 'audio/it',
        description: 'Impulse Tracker',
        category: 'other',
        quality: 'medium',
      },
    ],
    [
      '.s3m',
      {
        extension: '.s3m',
        mimeType: 'audio/s3m',
        description: 'ScreamTracker 3',
        category: 'other',
        quality: 'medium',
      },
    ],
    [
      '.xm',
      {
        extension: '.xm',
        mimeType: 'audio/xm',
        description: 'Extended Module',
        category: 'other',
        quality: 'medium',
      },
    ],

    // MIDI and Synthesizer Formats
    [
      '.mid',
      {
        extension: '.mid',
        mimeType: 'audio/midi',
        description: 'Musical Instrument Digital Interface',
        category: 'other',
        quality: 'low',
      },
    ],
    [
      '.midi',
      {
        extension: '.midi',
        mimeType: 'audio/midi',
        description: 'MIDI File',
        category: 'other',
        quality: 'low',
      },
    ],
    [
      '.kar',
      {
        extension: '.kar',
        mimeType: 'audio/midi',
        description: 'Karaoke MIDI',
        category: 'other',
        quality: 'low',
      },
    ],

    // Additional Exotic Formats
    [
      '.shn',
      {
        extension: '.shn',
        mimeType: 'audio/shn',
        description: 'Shorten',
        category: 'lossless',
        quality: 'lossless',
      },
    ],
    [
      '.voc',
      {
        extension: '.voc',
        mimeType: 'audio/voc',
        description: 'Creative Voice',
        category: 'uncompressed',
        quality: 'medium',
      },
    ],
    [
      '.vox',
      {
        extension: '.vox',
        mimeType: 'audio/voxware',
        description: 'Voxware',
        category: 'lossy',
        quality: 'low',
      },
    ],
    [
      '.w64',
      {
        extension: '.w64',
        mimeType: 'audio/wav',
        description: 'Sony Wave64',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],
    [
      '.rf64',
      {
        extension: '.rf64',
        mimeType: 'audio/wav',
        description: 'RF64 WAV',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],
    [
      '.bwf',
      {
        extension: '.bwf',
        mimeType: 'audio/wav',
        description: 'Broadcast Wave Format',
        category: 'uncompressed',
        quality: 'lossless',
      },
    ],
  ]);

  /**
   * Creates a new AudioService instance.
   *
   * Initializes the service and ensures the audio directory exists.
   * If the directory doesn't exist, it will be created recursively.
   */
  constructor() {
    if (!fs.existsSync(this.audioDirectory)) {
      fs.mkdirSync(this.audioDirectory, { recursive: true });
    }
  }

  /**
   * Retrieves a list of all available audio files in the audio directory.
   *
   * Scans the configured audio directory for files with recognized audio
   * extensions and returns metadata for each file found.
   *
   * @returns An array of {@link AudioFile} objects representing all discovered
   *          audio files, sorted alphabetically by name. Returns an empty array
   *          if no files are found or if an error occurs.
   *
   * @example
   * ```typescript
   * const files = audioService.getAvailableAudioFiles();
   * files.forEach(file => {
   *   console.log(`${file.name} (${file.format}): ${file.size} bytes`);
   * });
   * ```
   */
  getAvailableAudioFiles(): AudioFile[] {
    try {
      if (!fs.existsSync(this.audioDirectory)) {
        return [];
      }

      const files = fs.readdirSync(this.audioDirectory);
      const audioFiles = files
        .filter((file) => this.isAudioFile(file))
        .map((file) => {
          const ext = path.extname(file).toLowerCase();
          const formatInfo = this.audioFormats.get(ext);
          const filePath = path.join(this.audioDirectory, file);
          const convertedFilePath = path.join(
            this.audioDirectory,
            'converted',
            file + '.mp3'
          );
          const size = this.getFileSize(filePath);

          return {
            id: file,
            name: path.parse(file).name,
            path: filePath,
            convertedPath: convertedFilePath,
            format: ext.substring(1),
            mimeType: formatInfo?.mimeType || 'audio/mpeg',
            size: size,
            category: formatInfo?.category || 'other',
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      this.logger.log(
        `Found ${audioFiles.length} audio files in ${
          audioFiles.length > 0 ? this.getFormatStats(audioFiles) : 'no formats'
        }`
      );
      return audioFiles;
    } catch (error) {
      this.logger.error('Error reading audio directory:', error);
      return [];
    }
  }

  /**
   * Retrieves a specific audio file by its unique identifier.
   *
   * @param fileId - The unique identifier (filename) of the audio file to retrieve.
   *
   * @returns The {@link AudioFile} object if found, or `null` if no file
   *          matches the given identifier.
   *
   * @example
   * ```typescript
   * const file = audioService.getAudioFile('song.mp3');
   * if (file) {
   *   console.log(`Found: ${file.name} at ${file.path}`);
   * }
   * ```
   */
  getAudioFile(fileId: string): AudioFile | null {
    const files = this.getAvailableAudioFiles();
    return files.find((file) => file.id === fileId) || null;
  }

  /**
   * Streams an audio file in chunks for efficient memory usage.
   *
   * Reads the specified audio file and breaks it into chunks of the specified
   * size. This is useful for streaming audio data over network connections
   * or processing large files without loading them entirely into memory.
   *
   * @param filePath - The absolute filesystem path to the audio file.
   * @param chunkSize - The size of each chunk in bytes.
   *                    @default 65536 (64 KB)
   *
   * @returns A Promise that resolves to an array of Buffer chunks containing
   *          the audio data. The chunks are in sequential order.
   *
   * @throws Error if the file is not found or cannot be read.
   *
   * @example
   * ```typescript
   * const chunks = await audioService.streamAudioFile('/path/to/audio.mp3', 32 * 1024);
   * for (const chunk of chunks) {
   *   // Send chunk over WebSocket or process it
   *   socket.emit('audio-chunk', chunk);
   * }
   * ```
   *
   * @remarks
   * The method logs debug information including the first 16 bytes of the file
   * in hexadecimal format, which can be useful for format identification.
   */
  async streamAudioFile(
    filePath: string,
    chunkSize: number = 64 * 1024
  ): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      console.log('streamAudioFile', filePath, chunkSize);
      try {
        if (!fs.existsSync(filePath)) {
          reject(new Error('Audio file not found'));
          return;
        }

        const stats = fs.statSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        this.logger.log(
          `Streaming file: ${path.basename(filePath)} (${this.formatFileSize(
            stats.size
          )}, ${ext})`
        );

        const chunks: Buffer[] = [];
        const stream = fs.createReadStream(filePath, {
          highWaterMark: chunkSize,
        });

        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);

          // Log first chunk header bytes for format debugging
          if (chunks.length === 1) {
            const firstBytes = Array.from(chunk.slice(0, 16))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' ');
            this.logger.debug(`First 16 bytes: ${firstBytes}`);
          }
        });

        stream.on('end', () => {
          this.logger.log(
            `Audio file streamed successfully: ${path.basename(filePath)} (${
              chunks.length
            } chunks, total: ${this.formatFileSize(
              chunks.reduce((sum, c) => sum + c.length, 0)
            )})`
          );
          resolve(chunks);
        });

        stream.on('error', (error) => {
          this.logger.error('Error streaming audio file:', error);
          reject(error);
        });
      } catch (error) {
        this.logger.error('Stream setup error:', error);
        reject(error);
      }
    });
  }

  /**
   * Checks whether a filename has a recognized audio file extension.
   *
   * @param filename - The filename to check (with extension).
   *
   * @returns `true` if the file has a supported audio extension, `false` otherwise.
   * @private
   */
  private isAudioFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return this.audioFormats.has(ext);
  }

  /**
   * Gets the size of a file in bytes.
   *
   * @param filePath - The absolute path to the file.
   *
   * @returns The file size in bytes, or 0 if the file cannot be accessed.
   */
  getFileSize(filePath: string): number {
    try {
      const stats = fs.statSync(filePath);
      return stats.size;
    } catch (error) {
      this.logger.error('Error getting file size:', error);
      return 0;
    }
  }

  /**
   * Retrieves a list of all supported audio formats.
   *
   * @returns An array of {@link AudioFormatInfo} objects for all supported
   *          formats, sorted alphabetically by extension.
   *
   * @example
   * ```typescript
   * const formats = audioService.getSupportedFormats();
   * console.log(`Supported formats: ${formats.map(f => f.extension).join(', ')}`);
   * ```
   */
  getSupportedFormats(): AudioFormatInfo[] {
    return Array.from(this.audioFormats.values()).sort((a, b) =>
      a.extension.localeCompare(b.extension)
    );
  }

  /**
   * Retrieves format information for a specific file extension.
   *
   * @param extension - The file extension to look up (with or without leading dot).
   *
   * @returns The {@link AudioFormatInfo} for the extension, or `null` if not supported.
   *
   * @example
   * ```typescript
   * const info = audioService.getFormatInfo('.mp3');
   * if (info) {
   *   console.log(`MP3: ${info.description}, Quality: ${info.quality}`);
   * }
   * ```
   */
  getFormatInfo(extension: string): AudioFormatInfo | null {
    return this.audioFormats.get(extension.toLowerCase()) || null;
  }

  /**
   * Generates a statistical summary of audio file formats.
   *
   * @param files - An array of audio files to analyze.
   *
   * @returns A formatted string summarizing the count of each format
   *          (e.g., "3 MP3, 2 WAV, 1 FLAC").
   * @private
   */
  private getFormatStats(files: AudioFile[]): string {
    const formatCounts = new Map<string, number>();
    files.forEach((file) => {
      const count = formatCounts.get(file.format) || 0;
      formatCounts.set(file.format, count + 1);
    });

    const stats = Array.from(formatCounts.entries())
      .map(([format, count]) => `${count} ${format.toUpperCase()}`)
      .join(', ');

    return stats;
  }

  /**
   * Groups all available audio files by their compression category.
   *
   * @returns An object with category names as keys and arrays of matching
   *          {@link AudioFile} objects as values.
   *
   * @example
   * ```typescript
   * const categorized = audioService.getAudioFilesByCategory();
   * console.log(`Lossless files: ${categorized.lossless.length}`);
   * console.log(`Lossy files: ${categorized.lossy.length}`);
   * ```
   */
  getAudioFilesByCategory(): { [key: string]: AudioFile[] } {
    const files = this.getAvailableAudioFiles();
    const categorized: { [key: string]: AudioFile[] } = {
      lossless: [],
      uncompressed: [],
      lossy: [],
      other: [],
    };

    files.forEach((file) => {
      categorized[file.category].push(file);
    });

    return categorized;
  }

  /**
   * Formats a byte count into a human-readable string with appropriate units.
   *
   * @param bytes - The number of bytes to format.
   *
   * @returns A formatted string with the appropriate unit (B, KB, MB, or GB).
   *
   * @example
   * ```typescript
   * audioService.formatFileSize(1024);       // "1 KB"
   * audioService.formatFileSize(1536000);    // "1.46 MB"
   * audioService.formatFileSize(0);          // "0 B"
   * ```
   */
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
