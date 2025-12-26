import { CommonModule } from '@angular/common';
import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AudioStreamService, AudioEncoder } from './audio-stream-service';
import { AudioTransport } from './audio-transport';

@Component({
  selector: 'app-audio-widget',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './audio-widget.component.html',
  styleUrl: './audio-widget.component.scss',
})
export class AudioWidgetComponent implements OnInit, OnDestroy {
  @Input() transportUrl?: string;

  encoder: AudioEncoder = 'pcm';
  levelPercent = 0;
  levelText = '– dB';
  running = false;
  connectionState: 'verbunden' | 'getrennt' = 'getrennt';
  streamingState = false;
  fallbackActive = false;
  fallbackReason = 'keine Fallbacks';
  statusLog: string[] = [];

  private streamService?: AudioStreamService;
  private transport?: AudioTransport;

  ngOnInit(): void {
    const url = this.transportUrl ?? this.resolveTransportUrl();

    this.streamService = new AudioStreamService({
      onLevel: ({ rms, db }) => this.updateLevel(rms, db),
      onChunk: (chunk) => this.transport?.sendChunk(chunk),
      onStatus: (message) => this.logStatus(message),
    });

    this.transport = new AudioTransport({
      url,
      onBinary: (data) => void this.streamService?.playAudioChunk(data),
      onStatus: (msg) => this.logStatus(`Transport: ${msg}`),
      onConnectionChange: (state) => this.setConnectionState(state),
      onStreamingChange: (active) => this.setStreamingState(active),
      onFallback: (reason) => this.showFallback(reason),
      onError: (err) => this.logStatus(`Fehler: ${err}`),
    });
  }

  ngOnDestroy(): void {
    void this.stop();
  }

  async start(): Promise<void> {
    this.resetFallbackBadge();
    try {
      await this.transport?.connect();
      await this.streamService?.startCapture({ encoder: this.encoder });
      this.setRunning(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler');
      this.logStatus(`Start fehlgeschlagen: ${message}`);
      this.setRunning(false);
    }
  }

  async stop(): Promise<void> {
    await this.streamService?.stopCapture();
    this.transport?.close();
    this.setRunning(false);
  }

  get statusBadgeClass(): string {
    return this.running ? 'badge badge-live' : 'badge badge-idle';
  }

  get streamingBadgeClass(): string {
    return this.streamingState ? 'badge badge-live' : 'badge badge-idle';
  }

  get connectionBadgeClass(): string {
    return this.connectionState === 'verbunden' ? 'badge badge-live' : 'badge badge-idle';
  }

  get fallbackBadgeClass(): string {
    if (this.fallbackActive) {
      return 'badge badge-warn';
    }
    return 'badge badge-idle';
  }

  get statusBadgeText(): string {
    return this.running ? 'läuft' : 'bereit';
  }

  get streamingBadgeText(): string {
    return this.streamingState ? 'Streaming' : 'wartet';
  }

  private updateLevel(rms: number, db: number): void {
    const percent = Math.min(1, rms * 6);
    this.levelPercent = Number((percent * 100).toFixed(0));
    this.levelText = `${db.toFixed(1)} dB`;
  }

  private logStatus(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.statusLog.unshift(`[${timestamp}] ${message}`);
    this.statusLog = this.statusLog.slice(0, 6);
  }

  private setRunning(running: boolean): void {
    this.running = running;
  }

  private setConnectionState(state: 'verbunden' | 'getrennt'): void {
    this.connectionState = state;
  }

  private setStreamingState(active: boolean): void {
    this.streamingState = active;
  }

  private showFallback(reason?: string): void {
    this.fallbackActive = true;
    this.fallbackReason = 'Fallback aktiv';
    if (reason) {
      this.logStatus(`Fallback: ${reason}`);
    }
  }

  private resetFallbackBadge(): void {
    this.fallbackActive = false;
    this.fallbackReason = 'keine Fallbacks';
  }

  private resolveTransportUrl(): string {
    if (typeof window === 'undefined') {
      return 'ws://localhost:3000';
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.hostname}:3000`;
  }
}
