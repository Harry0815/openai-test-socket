
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface AudioFile {
  id: string;
  name: string;
  path: string;
  duration?: number;
  format: string;
  mimeType: string;
  size: number;
  category: 'lossy' | 'lossless' | 'uncompressed' | 'other';
}

export interface AudioFormatInfo {
  extension: string;
  mimeType: string;
  description: string;
  category: 'lossy' | 'lossless' | 'uncompressed' | 'other';
  quality: 'low' | 'medium' | 'high' | 'lossless';
}

@Injectable()
export class OwnAudioService {
  private readonly logger = new Logger(OwnAudioService.name);
  private readonly audioDirectory = path.join(process.cwd(), 'apps/test-socket/src/assets/audio');

  // Erweiterte Audio-Format-Definitionen
  private readonly audioFormats: Map<string, AudioFormatInfo> = new Map([
    // Verlustfreie Formate (Lossless)
    ['.flac', { extension: '.flac', mimeType: 'audio/flac', description: 'Free Lossless Audio Codec', category: 'lossless', quality: 'lossless' }],
    ['.alac', { extension: '.alac', mimeType: 'audio/mp4', description: 'Apple Lossless Audio Codec', category: 'lossless', quality: 'lossless' }],
    ['.ape', { extension: '.ape', mimeType: 'audio/ape', description: 'Monkey\'s Audio', category: 'lossless', quality: 'lossless' }],
    ['.wv', { extension: '.wv', mimeType: 'audio/wavpack', description: 'WavPack', category: 'lossless', quality: 'lossless' }],
    ['.tta', { extension: '.tta', mimeType: 'audio/tta', description: 'True Audio', category: 'lossless', quality: 'lossless' }],
    ['.tak', { extension: '.tak', mimeType: 'audio/tak', description: 'Tom\'s lossless Audio Kompressor', category: 'lossless', quality: 'lossless' }],

    // Unkomprimierte Formate
    ['.wav', { extension: '.wav', mimeType: 'audio/wav', description: 'Waveform Audio File Format', category: 'uncompressed', quality: 'lossless' }],
    ['.aiff', { extension: '.aiff', mimeType: 'audio/aiff', description: 'Audio Interchange File Format', category: 'uncompressed', quality: 'lossless' }],
    ['.aifc', { extension: '.aifc', mimeType: 'audio/aiff', description: 'Audio Interchange File Format Compressed', category: 'uncompressed', quality: 'lossless' }],
    ['.au', { extension: '.au', mimeType: 'audio/basic', description: 'Sun Audio Format', category: 'uncompressed', quality: 'medium' }],
    ['.snd', { extension: '.snd', mimeType: 'audio/basic', description: 'Sound File', category: 'uncompressed', quality: 'medium' }],
    ['.pcm', { extension: '.pcm', mimeType: 'audio/pcm', description: 'Pulse Code Modulation', category: 'uncompressed', quality: 'lossless' }],
    ['.raw', { extension: '.raw', mimeType: 'audio/pcm', description: 'Raw Audio Data', category: 'uncompressed', quality: 'lossless' }],

    // Verlustbehaftete Formate (Lossy) - Hohe Qualität
    ['.mp3', { extension: '.mp3', mimeType: 'audio/mpeg', description: 'MPEG Audio Layer III', category: 'lossy', quality: 'high' }],
    ['.aac', { extension: '.aac', mimeType: 'audio/aac', description: 'Advanced Audio Coding', category: 'lossy', quality: 'high' }],
    ['.m4a', { extension: '.m4a', mimeType: 'audio/mp4', description: 'MPEG-4 Audio', category: 'lossy', quality: 'high' }],
    ['.ogg', { extension: '.ogg', mimeType: 'audio/ogg', description: 'Ogg Vorbis', category: 'lossy', quality: 'high' }],
    ['.oga', { extension: '.oga', mimeType: 'audio/ogg', description: 'Ogg Audio', category: 'lossy', quality: 'high' }],
    ['.opus', { extension: '.opus', mimeType: 'audio/opus', description: 'Opus Audio Codec', category: 'lossy', quality: 'high' }],

    // Verlustbehaftete Formate - Mittlere Qualität
    ['.wma', { extension: '.wma', mimeType: 'audio/x-ms-wma', description: 'Windows Media Audio', category: 'lossy', quality: 'medium' }],
    ['.mp2', { extension: '.mp2', mimeType: 'audio/mpeg', description: 'MPEG Audio Layer II', category: 'lossy', quality: 'medium' }],
    ['.mp1', { extension: '.mp1', mimeType: 'audio/mpeg', description: 'MPEG Audio Layer I', category: 'lossy', quality: 'medium' }],
    ['.mpc', { extension: '.mpc', mimeType: 'audio/musepack', description: 'Musepack', category: 'lossy', quality: 'high' }],
    ['.spx', { extension: '.spx', mimeType: 'audio/speex', description: 'Speex', category: 'lossy', quality: 'medium' }],

    // Sprachoptimierte Formate
    ['.amr', { extension: '.amr', mimeType: 'audio/amr', description: 'Adaptive Multi-Rate', category: 'lossy', quality: 'low' }],
    ['.awb', { extension: '.awb', mimeType: 'audio/amr-wb', description: 'AMR-WB (Wideband)', category: 'lossy', quality: 'medium' }],
    ['.gsm', { extension: '.gsm', mimeType: 'audio/gsm', description: 'Global System for Mobile', category: 'lossy', quality: 'low' }],

    // Weitere Spezialformate
    ['.ra', { extension: '.ra', mimeType: 'audio/vnd.rn-realaudio', description: 'RealAudio', category: 'lossy', quality: 'medium' }],
    ['.rm', { extension: '.rm', mimeType: 'audio/vnd.rn-realaudio', description: 'RealMedia', category: 'lossy', quality: 'medium' }],
    ['.3gp', { extension: '.3gp', mimeType: 'audio/3gpp', description: '3GPP Audio', category: 'lossy', quality: 'low' }],
    ['.3g2', { extension: '.3g2', mimeType: 'audio/3gpp2', description: '3GPP2 Audio', category: 'lossy', quality: 'low' }],
    ['.caf', { extension: '.caf', mimeType: 'audio/x-caf', description: 'Core Audio Format', category: 'other', quality: 'high' }],
    ['.dts', { extension: '.dts', mimeType: 'audio/dts', description: 'DTS Audio', category: 'lossy', quality: 'high' }],
    ['.ac3', { extension: '.ac3', mimeType: 'audio/ac3', description: 'Dolby Digital AC-3', category: 'lossy', quality: 'high' }],
    ['.eac3', { extension: '.eac3', mimeType: 'audio/eac3', description: 'Enhanced AC-3', category: 'lossy', quality: 'high' }],
    ['.mlp', { extension: '.mlp', mimeType: 'audio/mlp', description: 'Meridian Lossless Packing', category: 'lossless', quality: 'lossless' }],
    ['.thd', { extension: '.thd', mimeType: 'audio/truehd', description: 'Dolby TrueHD', category: 'lossless', quality: 'lossless' }],

    // Module/Tracker-Formate
    ['.mod', { extension: '.mod', mimeType: 'audio/mod', description: 'Module File', category: 'other', quality: 'medium' }],
    ['.it', { extension: '.it', mimeType: 'audio/it', description: 'Impulse Tracker', category: 'other', quality: 'medium' }],
    ['.s3m', { extension: '.s3m', mimeType: 'audio/s3m', description: 'ScreamTracker 3', category: 'other', quality: 'medium' }],
    ['.xm', { extension: '.xm', mimeType: 'audio/xm', description: 'Extended Module', category: 'other', quality: 'medium' }],

    // MIDI und Synthesizer
    ['.mid', { extension: '.mid', mimeType: 'audio/midi', description: 'Musical Instrument Digital Interface', category: 'other', quality: 'low' }],
    ['.midi', { extension: '.midi', mimeType: 'audio/midi', description: 'MIDI File', category: 'other', quality: 'low' }],
    ['.kar', { extension: '.kar', mimeType: 'audio/midi', description: 'Karaoke MIDI', category: 'other', quality: 'low' }],

    // Weitere exotische Formate
    ['.shn', { extension: '.shn', mimeType: 'audio/shn', description: 'Shorten', category: 'lossless', quality: 'lossless' }],
    ['.voc', { extension: '.voc', mimeType: 'audio/voc', description: 'Creative Voice', category: 'uncompressed', quality: 'medium' }],
    ['.vox', { extension: '.vox', mimeType: 'audio/voxware', description: 'Voxware', category: 'lossy', quality: 'low' }],
    ['.w64', { extension: '.w64', mimeType: 'audio/wav', description: 'Sony Wave64', category: 'uncompressed', quality: 'lossless' }],
    ['.rf64', { extension: '.rf64', mimeType: 'audio/wav', description: 'RF64 WAV', category: 'uncompressed', quality: 'lossless' }],
    ['.bwf', { extension: '.bwf', mimeType: 'audio/wav', description: 'Broadcast Wave Format', category: 'uncompressed', quality: 'lossless' }],
  ]);

  constructor() {
    // Erstelle Audio-Verzeichnis falls es nicht existiert
    if (!fs.existsSync(this.audioDirectory)) {
      fs.mkdirSync(this.audioDirectory, { recursive: true });
    }
  }

  getAvailableAudioFiles(): AudioFile[] {
    try {
      if (!fs.existsSync(this.audioDirectory)) {
        return [];
      }

      const files = fs.readdirSync(this.audioDirectory);
      const audioFiles = files
        .filter(file => this.isAudioFile(file))
        .map(file => {
          const ext = path.extname(file).toLowerCase();
          const formatInfo = this.audioFormats.get(ext);
          const filePath = path.join(this.audioDirectory, file);
          const size = this.getFileSize(filePath);

          return {
            id: file,
            name: path.parse(file).name,
            path: filePath,
            format: ext.substring(1),
            mimeType: formatInfo?.mimeType || 'audio/mpeg',
            size: size,
            category: formatInfo?.category || 'other'
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      this.logger.log(`Found ${audioFiles.length} audio files in ${audioFiles.length > 0 ? this.getFormatStats(audioFiles) : 'no formats'}`);
      return audioFiles;
    } catch (error) {
      this.logger.error('Error reading audio directory:', error);
      return [];
    }
  }

  getAudioFile(fileId: string): AudioFile | null {
    const files = this.getAvailableAudioFiles();
    return files.find(file => file.id === fileId) || null;
  }

  async streamAudioFile(filePath: string, chunkSize: number = 64 * 1024): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(filePath)) {
          reject(new Error('Audio file not found'));
          return;
        }

        // Log file info for debugging
        const stats = fs.statSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        this.logger.log(`Streaming file: ${path.basename(filePath)} (${this.formatFileSize(stats.size)}, ${ext})`);

        const chunks: Buffer[] = [];
        const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });

        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);

          // Log first chunk info for debugging
          if (chunks.length === 1) {
            const firstBytes = Array.from(chunk.slice(0, 16))
              .map(b => b.toString(16).padStart(2, '0'))
              .join(' ');
            this.logger.debug(`First 16 bytes: ${firstBytes}`);
          }
        });

        stream.on('end', () => {
          this.logger.log(`Audio file streamed successfully: ${path.basename(filePath)} (${chunks.length} chunks, total: ${this.formatFileSize(chunks.reduce((sum, c) => sum + c.length, 0))})`);
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

// ... existing code ...
  private isAudioFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return this.audioFormats.has(ext);
  }

  getFileSize(filePath: string): number {
    try {
      const stats = fs.statSync(filePath);
      return stats.size;
    } catch (error) {
      this.logger.error('Error getting file size:', error);
      return 0;
    }
  }

  getSupportedFormats(): AudioFormatInfo[] {
    return Array.from(this.audioFormats.values()).sort((a, b) => a.extension.localeCompare(b.extension));
  }

  getFormatInfo(extension: string): AudioFormatInfo | null {
    return this.audioFormats.get(extension.toLowerCase()) || null;
  }

  private getFormatStats(files: AudioFile[]): string {
    const formatCounts = new Map<string, number>();
    files.forEach(file => {
      const count = formatCounts.get(file.format) || 0;
      formatCounts.set(file.format, count + 1);
    });

    const stats = Array.from(formatCounts.entries())
      .map(([format, count]) => `${count} ${format.toUpperCase()}`)
      .join(', ');

    return stats;
  }

  getAudioFilesByCategory(): { [key: string]: AudioFile[] } {
    const files = this.getAvailableAudioFiles();
    const categorized: { [key: string]: AudioFile[] } = {
      lossless: [],
      uncompressed: [],
      lossy: [],
      other: []
    };

    files.forEach(file => {
      categorized[file.category].push(file);
    });

    return categorized;
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
