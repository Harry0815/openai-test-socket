import { CommonModule } from '@angular/common';
import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { AudioStreamService } from './audio-stream.service';
import { AudioTransport } from './audio-transport.service';

@Component({
  selector: 'app-audio-widget',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './audio-widget.component.html',
  styleUrls: ['./audio-widget.component.css'],
})
export class AudioWidgetComponent implements OnInit, OnDestroy {
  @Input() transportUrl = 'ws://localhost:3000';

  statusLog: string[] = [];
  connectionState = 'getrennt';
  streamingState = false;
  isRunning = false;
  fallbackActive = false;
  fallbackReason = '';
  levelPercent = 0;
  levelDb = 0;
  selectedEncoder: 'pcm' | 'opus' = 'pcm';

  private streamService: AudioStreamService;
  private transport?: AudioTransport;
  private sequence = 0;

  constructor() {
    this.streamService = new AudioStreamService({
      onLevel: (level) => this.updateLevel(level),
      onChunk: (chunk) => this.sendChunk(chunk),
      onStatus: (message) => this.logStatus(message),
    });
  }

  ngOnInit() {
    this.initTransport();
  }

  ngOnDestroy() {
    this.streamService.stopCapture();
    this.transport?.close();
  }

  async start() {
    this.resetFallbackBadge();
    try {
      await this.streamService.startCapture({ encoder: this.selectedEncoder });
      this.setRunning(true);
    } catch (err) {
      const detail = (err as { message?: string })?.message ?? String(err);
      this.logStatus(`Start fehlgeschlagen: ${detail}`);
      this.setRunning(false);
    }
  }

  async stop() {
    await this.streamService.stopCapture();
    this.transport?.close();
    this.setRunning(false);
  }

  onEncoderChange(value: string) {
    if (value === 'opus' || value === 'pcm') {
      this.selectedEncoder = value;
    }
  }

  get statusBadgeLabel() {
    return this.isRunning ? 'läuft' : 'bereit';
  }

  get statusBadgeClass() {
    return this.isRunning ? 'badge badge-live' : 'badge badge-idle';
  }

  get connectionBadgeLabel() {
    return this.connectionState === 'verbunden' ? 'verbunden' : 'getrennt';
  }

  get connectionBadgeClass() {
    return this.connectionState === 'verbunden' ? 'badge badge-live' : 'badge badge-idle';
  }

  get streamingBadgeLabel() {
    return this.streamingState ? 'Streaming' : 'wartet';
  }

  get streamingBadgeClass() {
    return this.streamingState ? 'badge badge-live' : 'badge badge-idle';
  }

  get fallbackBadgeLabel() {
    return this.fallbackActive ? 'Fallback aktiv' : 'keine Fallbacks';
  }

  get fallbackBadgeClass() {
    if (!this.fallbackActive) {
      return 'badge badge-idle';
    }
    return 'badge badge-warn';
  }

  get statusLogText() {
    return this.statusLog.join('\n');
  }

  private initTransport() {
    this.transport?.close();
    this.transport = new AudioTransport({
      url: this.transportUrl,
      onBinary: (data) => this.streamService.playAudioChunk(data),
      onStatus: (message) => this.logStatus(`Transport: ${message}`),
      onConnectionChange: (state) => this.setConnectionState(state),
      onStreamingChange: (active) => this.setStreamingState(active),
      onFallback: (reason) => this.showFallback(reason),
      onError: (err) => this.logStatus(`Fehler: ${err}`),
    });
  }

  private sendChunk(chunk: { payload: Uint8Array; encoder: 'pcm' | 'opus'; mimeType?: string }) {
    this.transport?.sendChunk({
      payload: chunk.payload,
      encoder: chunk.encoder,
      mimeType: chunk.mimeType,
      sequence: this.sequence++,
    });
  }

  private updateLevel({ rms, db }: { rms: number; db: number }) {
    const percent = Math.min(1, rms * 6);
    this.levelPercent = Number((percent * 100).toFixed(0));
    this.levelDb = db;
  }

  private logStatus(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.statusLog.unshift(`[${timestamp}] ${message}`);
    this.statusLog = this.statusLog.slice(0, 6);
  }

  private setRunning(running: boolean) {
    this.isRunning = running;
  }

  private setConnectionState(state: string) {
    this.connectionState = state;
  }

  private setStreamingState(active: boolean) {
    this.streamingState = active;
  }

  private showFallback(reason?: string) {
    this.fallbackActive = true;
    this.fallbackReason = reason ?? '';
    if (reason) {
      this.logStatus(`Fallback: ${reason}`);
    }
  }

  private resetFallbackBadge() {
    this.fallbackActive = false;
    this.fallbackReason = '';
  }
}
