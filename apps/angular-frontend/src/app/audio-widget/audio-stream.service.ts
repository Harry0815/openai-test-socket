const DEFAULT_SAMPLE_RATE = 24000;

export type AudioChunkPayload = {
  encoder: 'pcm' | 'opus';
  payload: Uint8Array;
  mimeType?: string;
};

export type AudioLevel = {
  rms: number;
  db: number;
};

export type AudioStreamHandlers = {
  onLevel?: (level: AudioLevel) => void;
  onChunk?: (chunk: AudioChunkPayload) => void;
  onStatus?: (message: string) => void;
};

/**
 * AudioStreamService kapselt die Aufnahme (getUserMedia),
 * eine einfache PCM-Extraktion sowie die AudioContext-Wiedergabe
 * eingehender Binärdaten (z. B. aus TTS).
 */
export class AudioStreamService {
  private onLevel?: (level: AudioLevel) => void;
  private onChunk?: (chunk: AudioChunkPayload) => void;
  private onStatus?: (message: string) => void;

  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private encoder: 'pcm' | 'opus' = 'pcm';
  private isCapturing = false;
  private playbackGain: GainNode | null = null;

  constructor({ onLevel, onChunk, onStatus }: AudioStreamHandlers = {}) {
    this.onLevel = onLevel;
    this.onChunk = onChunk;
    this.onStatus = onStatus;
  }

  async ensureContext(sampleRate = DEFAULT_SAMPLE_RATE) {
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
  }: {
    encoder?: 'pcm' | 'opus';
    useNoiseSuppression?: boolean;
    useEchoCancellation?: boolean;
    chunkSize?: number;
  } = {}) {
    if (this.isCapturing) {
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

    this.sourceNode = this.audioContext?.createMediaStreamSource(this.mediaStream) ?? null;
    this.analyser = this.audioContext?.createAnalyser() ?? null;
    if (this.analyser && this.sourceNode) {
      this.analyser.fftSize = 2048;
      this.sourceNode.connect(this.analyser);
    }

    if (
      encoder === 'opus' &&
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ) {
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: 'audio/webm;codecs=opus',
        bitsPerSecond: 48000 * 16,
      });
      this.mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && this.onChunk) {
          const arrayBuffer = await event.data.arrayBuffer();
          this.onChunk({
            encoder: 'opus',
            payload: new Uint8Array(arrayBuffer),
            mimeType: this.mediaRecorder?.mimeType ?? 'audio/webm;codecs=opus',
          });
        }
      };
      this.mediaRecorder.start();
      this._notifyStatus('Aufnahme gestartet (Opus via MediaRecorder)');
    } else {
      await this._startPcmProcessor(chunkSize);
      this._notifyStatus('Aufnahme gestartet (PCM)');
    }

    this._startLevelMeter();
    this.isCapturing = true;
  }

  private async _startPcmProcessor(chunkSize: number) {
    const processorSize = Math.max(1024, Math.min(chunkSize, 16384));
    this.processorNode = this.audioContext?.createScriptProcessor(processorSize, 1, 1) ?? null;
    if (!this.processorNode || !this.sourceNode || !this.audioContext) {
      return;
    }
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    this.processorNode.onaudioprocess = (event) => {
      const channelData = event.inputBuffer.getChannelData(0);
      const pcmChunk = this._floatTo16BitPCM(channelData);
      this.onChunk?.({ encoder: 'pcm', payload: pcmChunk, mimeType: 'audio/pcm' });
    };
  }

  private _floatTo16BitPCM(float32Array: Float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      let sample = float32Array[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Uint8Array(buffer);
  }

  private _startLevelMeter() {
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
      for (let i = 0; i < dataArray.length; i++) {
        rms += dataArray[i] * dataArray[i];
      }
      rms = Math.sqrt(rms / dataArray.length);
      const db = 20 * Math.log10(rms || 0.00001);
      this.onLevel?.({ rms, db });
      this.levelTimer = requestAnimationFrame(loop);
    };
    this.levelTimer = requestAnimationFrame(loop);
  }

  async stopCapture() {
    if (!this.isCapturing) return;

    if (this.levelTimer) {
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
    this._notifyStatus('Aufnahme gestoppt');
  }

  async playAudioChunk(arrayBuffer: ArrayBuffer) {
    const context = await this.ensureContext();
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackGain ?? context.destination);
    source.start();
  }

  private _notifyStatus(message: string) {
    this.onStatus?.(message);
  }
}
