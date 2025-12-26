import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'node:stream';
import { ensureFfmpegConfigured } from './ffmpeg';
import { FixedSizeChunker } from './fixed-size-chunker';
import { JitterBuffer, JitterBufferOptions } from './jitter-buffer';

export interface BrowserToRtcPipelineOptions {
  inputFormat?: string;
  sampleRate?: number;
  chunkDurationMs?: number;
}

export interface RtcToBrowserPipelineOptions {
  outputFormat?: string;
  sampleRate?: number;
  chunkDurationMs?: number;
  jitterBuffer?: JitterBufferOptions;
}

export interface BrowserToRtcPipeline {
  input: PassThrough;
  output: FixedSizeChunker;
}

export interface RtcToBrowserPipeline {
  input: PassThrough;
  output: PassThrough;
  jitterBuffer: JitterBuffer;
}

export const DEFAULT_RTC_SAMPLE_RATE = 16_000;
export const DEFAULT_CHUNK_DURATION_MS = 20;

const calculateChunkSizeBytes = (sampleRate: number, channels: number, durationMs: number): number =>
  Math.round((sampleRate * channels * 2 * durationMs) / 1000);

export const createBrowserToRtcPipeline = (options: BrowserToRtcPipelineOptions = {}): BrowserToRtcPipeline => {
  ensureFfmpegConfigured();

  const input = new PassThrough();
  const sampleRate = options.sampleRate ?? DEFAULT_RTC_SAMPLE_RATE;
  const chunkDurationMs = options.chunkDurationMs ?? DEFAULT_CHUNK_DURATION_MS;
  const chunkSizeBytes = calculateChunkSizeBytes(sampleRate, 1, chunkDurationMs);

  const ffmpegProcess = ffmpeg(input)
    .inputFormat(options.inputFormat ?? 'webm')
    .audioCodec('pcm_s16le')
    .audioFrequency(sampleRate)
    .audioChannels(1)
    .format('s16le')
    .outputOptions(['-fflags', 'nobuffer', '-flags', 'low_delay'])
    .on('error', (err) => {
      input.emit('error', err);
    });

  const ffmpegOutput = ffmpegProcess.pipe();
  const chunker = new FixedSizeChunker(chunkSizeBytes);
  ffmpegOutput.pipe(chunker);

  return { input, output: chunker };
};

export const createRtcToBrowserPipeline = (options: RtcToBrowserPipelineOptions = {}): RtcToBrowserPipeline => {
  ensureFfmpegConfigured();

  const input = new PassThrough();
  const sampleRate = options.sampleRate ?? DEFAULT_RTC_SAMPLE_RATE;
  const chunkDurationMs = options.chunkDurationMs ?? DEFAULT_CHUNK_DURATION_MS;
  const chunkSizeBytes = calculateChunkSizeBytes(sampleRate, 1, chunkDurationMs) * 2;

  const ffmpegProcess = ffmpeg(input)
    .inputFormat('s16le')
    .audioFrequency(sampleRate)
    .audioChannels(1)
    .audioCodec('libopus')
    .format(options.outputFormat ?? 'webm')
    .outputOptions([
      '-application',
      'lowdelay',
      '-frame_duration',
      String(chunkDurationMs),
      '-vbr',
      'off',
      '-compression_level',
      '0',
    ])
    .on('error', (err) => {
      input.emit('error', err);
    });

  const ffmpegOutput = ffmpegProcess.pipe();
  const chunker = new FixedSizeChunker(chunkSizeBytes);
  const jitterBuffer = new JitterBuffer(options.jitterBuffer);
  const output = new PassThrough();

  jitterBuffer.on('data', (data: Buffer) => output.write(data));
  jitterBuffer.on('end', () => output.end());

  ffmpegOutput.pipe(chunker);
  chunker.on('data', (data: Buffer) => jitterBuffer.write(data));
  chunker.on('end', () => jitterBuffer.end());

  jitterBuffer.start();

  return { input, output, jitterBuffer };
};
