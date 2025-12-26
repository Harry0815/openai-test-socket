const DEFAULT_SAMPLE_RATE = 48000;

export type AudioEncoder = 'pcm' | 'opus';

export interface AudioStreamServiceOptions {
  onLevel?: (data: { rms: number; db: number }) => void;
  onChunk?: (chunk: { encoder: AudioEncoder; payload: Uint8Array }) => void;
  onStatus?: (message: string) => void;
}

export interface StartCaptureOptions {
  encoder?: AudioEncoder;
  useNoiseSuppression?: boolean;
  useEchoCancellation?: boolean;
  chunkSize?: number;
}

/**
 * AudioStreamService kapselt die Aufnahme (getUserMedia),
 * eine einfache PCM-Extraktion sowie die AudioContext-Wiedergabe
 * eingehender Binärdaten (z. B. aus TTS).
 */
export class AudioStreamService {
  private onLevel?: (data: { rms: number; db: number }) => void;
  private onChunk?: (chunk: { encoder: AudioEncoder; payload: Uint8Array }) => void;
  private onStatus?: (message: string) => void;

  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private encoder: AudioEncoder = 'pcm';
  private isCapturing = false;
  private playbackGain: GainNode | null = null;

  constructor({ onLevel, onChunk, onStatus }: AudioStreamServiceOptions = {}) {
    this.onLevel = onLevel;
    this.onChunk = onChunk;
    this.onStatus = onStatus;
  }

  async ensureContext(sampleRate: number = DEFAULT_SAMPLE_RATE): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate });
      this.playbackGain = this.audioContext.createGain();
      this.playbackGain.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  async startCapture({
    encoder = 'pcm',
    useNoiseSuppression = true,
    useEchoCancellation = true,
    chunkSize = 4096,
  }: StartCaptureOptions = {}): Promise<void> {
    if (this.isCapturing) {
      return;
    }
    if (this.audioContext === null) {
      return;
    }
    this.encoder = encoder;

    await this.ensureContext();
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: useEchoCancellation,
        noiseSuppression: useNoiseSuppression,
        channelCount: 1,
        sampleRate: this.audioContext?.sampleRate,
      },
      video: false,
    });

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.sourceNode.connect(this.analyser);

    if (
      encoder === 'opus' &&
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ) {
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: 'audio/webm;codecs=opus',
        bitsPerSecond: 48000 * 16,
      });
      this.mediaRecorder.ondataavailable = async (event: BlobEvent) => {
        if (event.data.size > 0 && this.onChunk) {
          const arrayBuffer = await event.data.arrayBuffer();
          this.onChunk({ encoder: 'opus', payload: new Uint8Array(arrayBuffer) });
        }
      };
      this.mediaRecorder.start();
      this.notifyStatus('Aufnahme gestartet (Opus via MediaRecorder)');
    } else {
      await this.startPcmProcessor(chunkSize);
      this.notifyStatus('Aufnahme gestartet (PCM)');
    }

    this.startLevelMeter();
    this.isCapturing = true;
  }

  private async startPcmProcessor(chunkSize: number): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioContext nicht initialisiert');
    }

    const processorSize = Math.max(1024, Math.min(chunkSize, 16384));
    this.processorNode = this.audioContext.createScriptProcessor(processorSize, 1, 1);
    this.sourceNode?.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const channelData = event.inputBuffer.getChannelData(0);
      const pcmChunk = this.floatTo16BitPCM(channelData);
      if (this.onChunk) {
        this.onChunk({ encoder: 'pcm', payload: pcmChunk });
      }
    };
  }

  private floatTo16BitPCM(float32Array: Float32Array): Uint8Array {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i += 1) {
      let sample = float32Array[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Uint8Array(buffer);
  }

  private startLevelMeter(): void {
    if (!this.analyser) {
      return;
    }

    const dataArray = new Float32Array(this.analyser.frequencyBinCount);
    const loop = () => {
      if (!this.analyser) {
        return;
      }

      this.analyser.getFloatTimeDomainData(dataArray);
      let rms = 0;
      for (let i = 0; i < dataArray.length; i += 1) {
        rms += dataArray[i] * dataArray[i];
      }
      rms = Math.sqrt(rms / dataArray.length);
      const db = 20 * Math.log10(rms || 0.00001);
      this.onLevel?.({ rms, db });
      this.levelTimer = requestAnimationFrame(loop);
    };
    this.levelTimer = requestAnimationFrame(loop);
  }

  async stopCapture(): Promise<void> {
    if (!this.isCapturing) return;

    if (this.levelTimer !== null) {
      cancelAnimationFrame(this.levelTimer);
      this.levelTimer = null;
    }

    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
      this.mediaRecorder = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.isCapturing = false;
    this.notifyStatus('Aufnahme gestoppt');
  }

  async playAudioChunk(arrayBuffer: ArrayBuffer): Promise<void> {
    const context = await this.ensureContext();
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackGain ?? context.destination);
    source.start();
  }

  private notifyStatus(message: string): void {
    this.onStatus?.(message);
  }
}
