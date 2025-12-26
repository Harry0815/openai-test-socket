export interface AudioTransportOptions {
  url: string;
  onBinary?: (data: ArrayBuffer) => void;
  onStatus?: (msg: string) => void;
  onConnectionChange?: (state: 'verbunden' | 'getrennt') => void;
  onStreamingChange?: (active: boolean) => void;
  onFallback?: (reason?: string) => void;
  onError?: (err: string) => void;
}

/**
 * Schlanker Transport über WebSocket. Stellt optional einen
 * Offer/Answer-Aufbau für WebRTC bereit (wenn `useWebRTC` true ist),
 * fällt aber ansonsten auf reinen WS-Transport zurück.
 */
export class AudioTransport {
  private url: string;
  private socket: WebSocket | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private fallbackActive = false;
  private connectionState: 'connected' | 'disconnected' = 'disconnected';
  private streamingActive = false;

  private onBinary?: (data: ArrayBuffer) => void;
  private onStatus?: (msg: string) => void;
  private onConnectionChange?: (state: 'verbunden' | 'getrennt') => void;
  private onStreamingChange?: (active: boolean) => void;
  private onFallback?: (reason?: string) => void;
  private onError?: (err: string) => void;

  constructor({ url, onBinary, onStatus, onConnectionChange, onStreamingChange, onFallback, onError }: AudioTransportOptions) {
    this.url = url;
    this.onBinary = onBinary;
    this.onStatus = onStatus;
    this.onConnectionChange = onConnectionChange;
    this.onStreamingChange = onStreamingChange;
    this.onFallback = onFallback;
    this.onError = onError;

    void this.connect();
  }

  async connect(): Promise<void> {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      await this.openSocket();
      if (this.supportsWebRTC()) {
        await this.setupWebRTC();
      } else {
        this.activateFallback('WebRTC nicht verfügbar');
      }
    } catch (err) {
      this.notifyError('Verbindungsaufbau fehlgeschlagen', err);
      this.activateFallback('Fehler beim WebRTC-Aufbau, nutze WebSocket');
    }
  }

  private async openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this.connectionState = 'connected';
        this.notify(`Signaling verbunden (${this.url})`);
        this.onConnectionChange?.('verbunden');
        resolve();
      };

      this.socket.onerror = (err) => {
        this.notifyError('WebSocket Fehler', err);
        reject(err);
      };

      this.socket.onclose = () => {
        this.connectionState = 'disconnected';
        this.notify('Verbindung geschlossen');
        this.onConnectionChange?.('getrennt');
        this.setStreaming(false);
      };

      this.socket.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.onBinary?.(event.data);
          return;
        }

        if (event.data instanceof Blob) {
          const buffer = await event.data.arrayBuffer();
          this.onBinary?.(buffer);
          return;
        }

        try {
          const msg = JSON.parse(event.data as string);
          await this.handleSignal(msg);
        } catch (error) {
          this.notify(`Nachricht: ${String(event.data)}`);
        }
      };
    });
  }

  private async setupWebRTC(): Promise<void> {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    this.dataChannel = this.peerConnection.createDataChannel('audio');
    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
      this.notify('DataChannel offen – Streaming aktiv');
      this.setStreaming(true);
    };

    this.dataChannel.onclose = () => {
      this.notify('DataChannel geschlossen');
      this.setStreaming(false);
    };

    this.dataChannel.onerror = (err) => {
      this.notifyError('DataChannel Fehler', err);
      this.setStreaming(false);
    };

    this.dataChannel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.onBinary?.(event.data);
      } else if (typeof event.data === 'string') {
        this.notify(event.data);
      }
    };

    this.peerConnection.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.sendSignal({ type: 'ice', candidate });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection?.connectionState === 'failed') {
        this.activateFallback('WebRTC Verbindung fehlgeschlagen');
      }
    };

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.sendSignal({ type: 'offer', sdp: offer.sdp });
  }

  private async handleSignal(message: { type?: string; sdp?: string; candidate?: RTCIceCandidateInit; reason?: string }): Promise<void> {
    switch (message.type) {
      case 'answer':
        if (this.peerConnection && message.sdp) {
          const answerDesc = new RTCSessionDescription({ type: 'answer', sdp: message.sdp });
          await this.peerConnection.setRemoteDescription(answerDesc);
          this.notify('Answer erhalten, WebRTC aktiv');
        }
        break;
      case 'ice':
        if (this.peerConnection && message.candidate) {
          await this.peerConnection.addIceCandidate(message.candidate);
        }
        break;
      case 'fallback':
        this.activateFallback(message.reason || 'Server verlangt Fallback');
        break;
      default:
        this.notify(`Unbekanntes Signal: ${message.type}`);
    }
  }

  private sendSignal(payload: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private supportsWebRTC(): boolean {
    return typeof RTCPeerConnection !== 'undefined';
  }

  private activateFallback(reason: string): void {
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    this.notify(`Fallback aktiv: ${reason}`);
    this.onFallback?.(reason);
    this.setStreaming(this.socket?.readyState === WebSocket.OPEN);
  }

  sendChunk({ payload, encoder }: { payload: Uint8Array; encoder: string }): void {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(this.wrapPayload(payload, encoder));
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(this.wrapPayload(payload, encoder));
      if (!this.streamingActive) {
        this.setStreaming(true);
      }
      return;
    }

    this.notify('Kann Chunk nicht senden: keine aktive Verbindung');
  }

  close(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.setStreaming(false);
    this.onConnectionChange?.('getrennt');
  }

  private wrapPayload(payload: Uint8Array, _encoder: string): string {
    let binary = '';
    const len = payload.byteLength;
    for (let i = 0; i < len; i += 1) {
      binary += String.fromCharCode(payload[i]);
    }

    const base64Data = btoa(binary);

    return JSON.stringify({
      type: 'audio',
      data: base64Data,
    });
  }

  private setStreaming(active: boolean): void {
    this.streamingActive = active;
    this.onStreamingChange?.(active);
  }

  private notify(message: string): void {
    this.onStatus?.(message);
  }

  private notifyError(message: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler');
    this.notify(`${message}: ${detail}`);
    this.onError?.(detail);
  }
}
