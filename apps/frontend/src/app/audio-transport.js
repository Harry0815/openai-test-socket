/**
 * Schlanker Transport über WebSocket. Stellt optional einen
 * Offer/Answer-Aufbau für WebRTC bereit (wenn `useWebRTC` true ist),
 * fällt aber ansonsten auf reinen WS-Transport zurück.
 */
export class AudioTransport {
  constructor({ url, onBinary, onStatus, onConnectionChange, onStreamingChange, onFallback, onError } = {}) {
    this.url = url;
    this.socket = null;
    this.peerConnection = null;
    this.dataChannel = null;
    this.fallbackActive = false;
    this.connectionState = 'disconnected';
    this.streamingActive = false;

    this.onBinary = onBinary;
    this.onStatus = onStatus;
    this.onConnectionChange = onConnectionChange;
    this.onStreamingChange = onStreamingChange;
    this.onFallback = onFallback;
    this.onError = onError;
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

  async _openSocket() {
    return new Promise((resolve, reject) => {
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

        try {
          const msg = JSON.parse(event.data);
          await this._handleSignal(msg);
        } catch (error) {
          this._notify(`Nachricht: ${event.data}`);
        }
      };
    });
  }

  async _setupWebRTC() {
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
      if (this.peerConnection.connectionState === 'failed') {
        this._activateFallback('WebRTC Verbindung fehlgeschlagen');
      }
    };

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this._sendSignal({ type: 'offer', sdp: offer.sdp });
  }

  async _handleSignal(message) {
    switch (message.type) {
      case 'answer':
        if (this.peerConnection && message.sdp) {
          const answerDesc = new RTCSessionDescription({ type: 'answer', sdp: message.sdp });
          await this.peerConnection.setRemoteDescription(answerDesc);
          this._notify('Answer erhalten, WebRTC aktiv');
        }
        break;
      case 'ice':
        if (this.peerConnection && message.candidate) {
          await this.peerConnection.addIceCandidate(message.candidate);
        }
        break;
      case 'fallback':
        this._activateFallback(message.reason || 'Server verlangt Fallback');
        break;
      default:
        this._notify(`Unbekanntes Signal: ${message.type}`);
    }
  }

  _sendSignal(payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  _supportsWebRTC() {
    return typeof RTCPeerConnection !== 'undefined';
  }

  _activateFallback(reason) {
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    this._notify(`Fallback aktiv: ${reason}`);
    this.onFallback?.(reason);
    this._setStreaming(this.socket?.readyState === WebSocket.OPEN);
  }

  sendChunk({ payload, encoder }) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(this._wrapPayload(payload, encoder));
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(this._wrapPayload(payload, encoder));
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

  _wrapPayload(payload, encoder) {
    const header = JSON.stringify({ t: 'audio', encoder });
    const headerBytes = new TextEncoder().encode(header);
    const combined = new Uint8Array(4 + headerBytes.length + payload.length);
    const view = new DataView(combined.buffer);
    view.setUint32(0, headerBytes.length, true);
    combined.set(headerBytes, 4);
    combined.set(payload, 4 + headerBytes.length);
    return combined;
  }

  _setStreaming(active) {
    this.streamingActive = active;
    this.onStreamingChange?.(active);
  }

  _notify(message) {
    if (this.onStatus) {
      this.onStatus(message);
    }
  }

  _notifyError(message, err) {
    const detail = err?.message || err?.name || 'Unbekannter Fehler';
    this._notify(`${message}: ${detail}`);
    this.onError?.(detail);
  }
}
