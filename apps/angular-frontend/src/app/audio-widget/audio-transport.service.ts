export type AudioTransportHandlers = {
  onBinary?: (data: ArrayBuffer) => void;
  onStatus?: (message: string) => void;
  onConnectionChange?: (state: string) => void;
  onStreamingChange?: (active: boolean) => void;
  onFallback?: (reason?: string) => void;
  onError?: (err: string) => void;
};

export type AudioTransportChunk = {
  payload: Uint8Array;
  encoder: 'pcm' | 'opus';
  mimeType?: string;
  sequence: number;
};

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
  private connectionState = 'disconnected';
  private streamingActive = false;

  private onBinary?: (data: ArrayBuffer) => void;
  private onStatus?: (message: string) => void;
  private onConnectionChange?: (state: string) => void;
  private onStreamingChange?: (active: boolean) => void;
  private onFallback?: (reason?: string) => void;
  private onError?: (err: string) => void;

  constructor({ url, onBinary, onStatus, onConnectionChange, onStreamingChange, onFallback, onError }: AudioTransportHandlers & { url: string }) {
    this.url = url;
    this.onBinary = onBinary;
    this.onStatus = onStatus;
    this.onConnectionChange = onConnectionChange;
    this.onStreamingChange = onStreamingChange;
    this.onFallback = onFallback;
    this.onError = onError;

    this.connect();
  }

  async connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      await this._openSocket();
      if (this._supportsWebRTC()) {
        await this._setupWebRTC();
      } else {
        this._activateFallback('WebRTC nicht verfügbar');
      }
    } catch (err) {
      this._notifyError('Verbindungsaufbau fehlgeschlagen', err);
      this._activateFallback('Fehler beim WebRTC-Aufbau, nutze WebSocket');
    }
  }

  private async _openSocket() {
    return new Promise<void>((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this.connectionState = 'connected';
        this._notify(`Signaling verbunden (${this.url})`);
        this.onConnectionChange?.('verbunden');
        resolve();
      };

      this.socket.onerror = (err) => {
        this._notifyError('WebSocket Fehler', err);
        reject(err);
      };

      this.socket.onclose = () => {
        this.connectionState = 'disconnected';
        this._notify('Verbindung geschlossen');
        this.onConnectionChange?.('getrennt');
        this._setStreaming(false);
      };

      this.socket.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.onBinary?.(event.data);
          return;
        }

        if (typeof event.data !== 'string') {
          return;
        }

        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === 'play-data' && msg.data) {
            const buffer = this._normalizeBinaryPayload(msg.data);
            if (buffer) {
              this.onBinary?.(buffer);
            }
            return;
          }
          await this._handleSignal(msg);
        } catch (error) {
          this._notify(`Nachricht: ${event.data}`);
        }
      };
    });
  }

  private async _setupWebRTC() {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    this.dataChannel = this.peerConnection.createDataChannel('audio');
    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
      this._notify('DataChannel offen – Streaming aktiv');
      this._setStreaming(true);
    };

    this.dataChannel.onclose = () => {
      this._notify('DataChannel geschlossen');
      this._setStreaming(false);
    };

    this.dataChannel.onerror = (err) => {
      this._notifyError('DataChannel Fehler', err);
      this._setStreaming(false);
    };

    this.dataChannel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.onBinary?.(event.data);
      } else if (typeof event.data === 'string') {
        this._notify(event.data);
      }
    };

    this.peerConnection.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._sendSignal({ type: 'ice', candidate });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection?.connectionState === 'failed') {
        this._activateFallback('WebRTC Verbindung fehlgeschlagen');
      }
    };

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this._sendSignal({ type: 'offer', sdp: offer.sdp });
  }

  private async _handleSignal(message: { type?: string }) {
    switch (message.type) {
      case 'answer':
        if (this.peerConnection && 'sdp' in message && message.sdp) {
          const answerDesc = new RTCSessionDescription({ type: 'answer', sdp: message.sdp });
          await this.peerConnection.setRemoteDescription(answerDesc);
          this._notify('Answer erhalten, WebRTC aktiv');
        }
        break;
      case 'ice':
        if (this.peerConnection && 'candidate' in message && message.candidate) {
          await this.peerConnection.addIceCandidate(message.candidate);
        }
        break;
      case 'fallback':
        this._activateFallback('reason' in message ? message.reason : 'Server verlangt Fallback');
        break;
      default:
        if (message.type) {
          this._notify(`Unbekanntes Signal: ${message.type}`);
        }
    }
  }

  private _sendSignal(payload: unknown) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private _supportsWebRTC() {
    return typeof RTCPeerConnection !== 'undefined';
  }

  private _activateFallback(reason: string) {
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    this._notify(`Fallback aktiv: ${reason}`);
    this.onFallback?.(reason);
    this._setStreaming(this.socket?.readyState === WebSocket.OPEN);
  }

  sendChunk({ payload, encoder, mimeType, sequence }: AudioTransportChunk) {
    const payloadMessage = this._wrapPayload(payload, encoder, mimeType, sequence);
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(payloadMessage);
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(payloadMessage);
      if (!this.streamingActive) {
        this._setStreaming(true);
      }
      return;
    }

    this._notify('Kann Chunk nicht senden: keine aktive Verbindung');
  }

  close() {
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

    this._setStreaming(false);
    this.onConnectionChange?.('getrennt');
  }

  private _wrapPayload(payload: Uint8Array, encoder: 'pcm' | 'opus', mimeType: string | undefined, sequence: number) {
    const base64Data = this._toBase64(payload);
    return JSON.stringify({
      event: 'sound_data_from_client',
      data: {
        mimeType: mimeType ?? (encoder === 'opus' ? 'audio/webm;codecs=opus' : 'audio/pcm'),
        message: 'sound_data_from_client',
        chunk: base64Data,
        sequence,
      },
    });
  }

  private _toBase64(payload: Uint8Array) {
    let binary = '';
    const len = payload.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(payload[i]);
    }
    return btoa(binary);
  }

  private _normalizeBinaryPayload(data: unknown): ArrayBuffer | null {
    if (typeof data === 'string') {
      return this._fromBase64(data);
    }
    if (data && typeof data === 'object') {
      if ('data' in data && Array.isArray((data as { data: number[] }).data)) {
        return new Uint8Array((data as { data: number[] }).data).buffer;
      }
    }
    return null;
  }

  private _fromBase64(base64: string) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private _setStreaming(active: boolean) {
    this.streamingActive = active;
    this.onStreamingChange?.(active);
  }

  private _notify(message: string) {
    this.onStatus?.(message);
  }

  private _notifyError(message: string, err: unknown) {
    const detail = (err as { message?: string; name?: string })?.message || (err as { name?: string })?.name || 'Unbekannter Fehler';
    this._notify(`${message}: ${detail}`);
    this.onError?.(detail);
  }
}
