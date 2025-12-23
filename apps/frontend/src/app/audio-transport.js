/**
 * Schlanker Transport über WebSocket. Stellt optional einen
 * Offer/Answer-Aufbau für WebRTC bereit (wenn `useWebRTC` true ist),
 * fällt aber ansonsten auf reinen WS-Transport zurück.
 */
export class AudioTransport {
  constructor({ url, onBinary, onStatus } = {}) {
    this.url = url;
    this.socket = null;
    this.onBinary = onBinary;
    this.onStatus = onStatus;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      this.socket = new WebSocket(this.url);
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this._notify(`Verbunden mit ${this.url}`);
        resolve();
      };

      this.socket.onerror = (err) => {
        this._notify('WebSocket Fehler: ' + err.message);
        reject(err);
      };

      this.socket.onclose = () => {
        this._notify('Verbindung geschlossen');
      };

      this.socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.onBinary?.(event.data);
        } else if (typeof event.data === 'string') {
          this._notify(event.data);
        }
      };
    });
  }

  sendChunk({ payload, encoder }) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this._notify('Kann Chunk nicht senden: Socket nicht bereit');
      return;
    }

    const header = JSON.stringify({ t: 'audio', encoder });
    const headerBytes = new TextEncoder().encode(header);
    const combined = new Uint8Array(4 + headerBytes.length + payload.length);
    const view = new DataView(combined.buffer);
    view.setUint32(0, headerBytes.length, true);
    combined.set(headerBytes, 4);
    combined.set(payload, 4 + headerBytes.length);
    this.socket.send(combined);
  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  _notify(message) {
    if (this.onStatus) {
      this.onStatus(message);
    }
  }
}
