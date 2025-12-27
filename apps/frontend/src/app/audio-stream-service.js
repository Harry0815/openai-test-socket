const DEFAULT_SAMPLE_RATE = 24000;

/**
 * AudioStreamService kapselt die Aufnahme (getUserMedia),
 * eine einfache PCM-Extraktion sowie die AudioContext-Wiedergabe
 * eingehender Binärdaten (z. B. aus TTS).
 */
export class AudioStreamService {
  constructor({ onLevel, onChunk, onStatus } = {}) {
    this.onLevel = onLevel;
    this.onChunk = onChunk;
    this.onStatus = onStatus;

    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.analyser = null;
    this.levelTimer = null;
    this.mediaRecorder = null;
    this.encoder = 'pcm';
    this.isCapturing = false;
    this.playbackGain = null;
    this.nextPlaybackTime = 0;
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
  } = {}) {
    if (this.isCapturing) {
      return;
    }
    this.encoder = encoder;

    await this.ensureContext(DEFAULT_SAMPLE_RATE);
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: useEchoCancellation,
        noiseSuppression: useNoiseSuppression,
        channelCount: 1,
        sampleRate: DEFAULT_SAMPLE_RATE,
      },
      video: false,
    });

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.sourceNode.connect(this.analyser);

    if (encoder === 'opus' && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: 'audio/webm;codecs=opus',
        bitsPerSecond: 48000 * 16,
      });
      this.mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && this.onChunk) {
          const arrayBuffer = await event.data.arrayBuffer();
          this.onChunk({ encoder: 'opus', payload: new Uint8Array(arrayBuffer) });
        }
      };
      this.mediaRecorder.start();
      this._notifyStatus('Aufnahme gestartet (Opus via MediaRecorder)');
    } else {
      await this._startPcmProcessor(chunkSize);
      this._notifyStatus('Aufnahme gestartet (PCM, 24 kHz Mono)');
    }

    this._startLevelMeter();
    this.isCapturing = true;
  }

  async _startPcmProcessor(chunkSize) {
    const processorSize = Math.max(1024, Math.min(chunkSize, 16384));
    this.processorNode = this.audioContext.createScriptProcessor(processorSize, 1, 1);
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    this.processorNode.onaudioprocess = (event) => {
      const channelData = event.inputBuffer.getChannelData(0);
      const pcmChunk = this._floatTo16BitPCM(channelData);
      if (this.onChunk) {
        this.onChunk({ encoder: 'pcm', payload: pcmChunk });
      }
    };
  }

  _floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      let sample = float32Array[i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Uint8Array(buffer);
  }

  _startLevelMeter() {
    const dataArray = new Float32Array(this.analyser.frequencyBinCount);
    const loop = () => {
      this.analyser.getFloatTimeDomainData(dataArray);
      let rms = 0;
      for (let i = 0; i < dataArray.length; i++) {
        rms += dataArray[i] * dataArray[i];
      }
      rms = Math.sqrt(rms / dataArray.length);
      const db = 20 * Math.log10(rms || 0.00001);
      if (this.onLevel) {
        this.onLevel({ rms, db });
      }
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

  async playAudioChunk(arrayBuffer, meta = {}) {
    console.log('[AudioStreamService] playAudioChunk called, buffer size:', arrayBuffer?.byteLength, 'meta:', meta);
    const context = await this.ensureContext();
    if (!this.nextPlaybackTime) {
      this.nextPlaybackTime = context.currentTime;
    }
    const format = meta.format || 'pcm16';
    const sampleRate = meta.sampleRate || 24000;

    try {
      if (format === 'webm' || format === 'mp3' || format === 'wav') {
        console.log('[AudioStreamService] Decoding as', format);
        const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
        this._schedulePlayback(audioBuffer);
      } else {
        console.log('[AudioStreamService] Playing as PCM16, sampleRate:', sampleRate);
        const audioBuffer = await this._createPcm16Buffer(arrayBuffer, sampleRate);
        this._schedulePlayback(audioBuffer);
      }
    } catch (err) {
      console.error('[AudioStreamService] playAudioChunk error:', err);
      try {
        const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
        this._schedulePlayback(audioBuffer);
      } catch (fallbackErr) {
        this._notifyStatus(`Audio-Wiedergabe fehlgeschlagen: ${err.message}`);
      }
    }
  }

  _schedulePlayback(audioBuffer) {
    const context = this.audioContext;
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackGain);

    const startTime = Math.max(context.currentTime + 0.01, this.nextPlaybackTime || context.currentTime);
    source.start(startTime);
    this.nextPlaybackTime = startTime + audioBuffer.duration;

    console.log('[AudioStreamService] Audio scheduled at', startTime.toFixed(3), 'duration', audioBuffer.duration.toFixed(3));
  }

  async _createPcm16Buffer(arrayBuffer, sampleRate = 24000) {
    const context = await this.ensureContext();
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);

    console.log('[AudioStreamService] _playPcm16Chunk: samples:', int16Array.length, 'sampleRate:', sampleRate, 'duration:', (int16Array.length / sampleRate).toFixed(3), 's');

    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = context.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);
    return audioBuffer;
  }

  async _playPcm16Chunk(arrayBuffer, sampleRate = 24000) {
    const audioBuffer = await this._createPcm16Buffer(arrayBuffer, sampleRate);
    this._schedulePlayback(audioBuffer);
    console.log('[AudioStreamService] Audio playback started');
  }

  _notifyStatus(message) {
    if (this.onStatus) {
      this.onStatus(message);
    }
  }
}
