import { AudioStreamService } from './audio-stream-service.js';
import { AudioTransport } from './audio-transport.js';

const defaultConfig = {
  transportUrl: 'ws://localhost:3000/ws',
  encoder: 'pcm',
};

export class AudioWidget {
  constructor(root, config = {}) {
    this.root = root;
    this.config = { ...defaultConfig, ...config };
    this.statusLog = [];
    this.connectionState = 'getrennt';
    this.streamingState = false;

    this.streamService = new AudioStreamService({
      onLevel: this._updateLevel.bind(this),
      onChunk: this._sendChunk.bind(this),
      onStatus: this._logStatus.bind(this),
    });

    this.transport = new AudioTransport({
      url: this.config.transportUrl,
      onBinary: (data) => this.streamService.playAudioChunk(data),
      onStatus: (msg) => this._logStatus(`Transport: ${msg}`),
      onConnectionChange: (state) => this._setConnectionState(state),
      onStreamingChange: (active) => this._setStreamingState(active),
      onFallback: (reason) => this._showFallback(reason),
      onError: (err) => this._logStatus(`Fehler: ${err}`),
    });

    this._render();
  }

  async start() {
    this._resetFallbackBadge();
    try {
      // await this.transport.connect();
      await this.streamService.startCapture({ encoder: this.encoderSelect.value });
      this._setRunning(true);
    } catch (err) {
      this._logStatus(`Start fehlgeschlagen: ${err.message || err}`);
      this._setRunning(false);
    }
  }

  async stop() {
    this.streamService.stopCapture();
    this.transport.close();
    this._setRunning(false);
  }

  _sendChunk(chunk) {
    this.transport.sendChunk(chunk);
  }

  _updateLevel({ rms, db }) {
    const percent = Math.min(1, rms * 6); // simple scaling
    this.levelBar.style.width = `${(percent * 100).toFixed(0)}%`;
    this.levelText.textContent = `${db.toFixed(1)} dB`;
  }

  _logStatus(message) {
    const timestamp = new Date().toLocaleTimeString();
    this.statusLog.unshift(`[${timestamp}] ${message}`);
    this.statusLog = this.statusLog.slice(0, 6);
    this.statusBox.textContent = this.statusLog.join('\n');
  }

  _setRunning(running) {
    this.startButton.disabled = running;
    this.stopButton.disabled = !running;
    this.statusBadge.textContent = running ? 'läuft' : 'bereit';
    this.statusBadge.className = running ? 'badge badge-live' : 'badge badge-idle';
    this.streamingBadge.textContent = this.streamingState ? 'Streaming' : 'wartet';
    this.streamingBadge.className = this.streamingState ? 'badge badge-live' : 'badge badge-idle';
  }

  _setConnectionState(state) {
    this.connectionState = state;
    const isConnected = state === 'verbunden';
    this.connectionBadge.textContent = isConnected ? 'verbunden' : 'getrennt';
    this.connectionBadge.className = isConnected ? 'badge badge-live' : 'badge badge-idle';
  }

  _setStreamingState(active) {
    this.streamingState = active;
    this.streamingBadge.textContent = active ? 'Streaming' : 'wartet';
    this.streamingBadge.className = active ? 'badge badge-live' : 'badge badge-idle';
  }

  _showFallback(reason) {
    this.fallbackBadge.textContent = 'Fallback aktiv';
    this.fallbackBadge.className = 'badge badge-warn';
    if (reason) {
      this._logStatus(`Fallback: ${reason}`);
    }
  }

  _resetFallbackBadge() {
    this.fallbackBadge.textContent = 'keine Fallbacks';
    this.fallbackBadge.className = 'badge badge-idle';
  }

  _render() {
    this.root.classList.add('audio-widget');
    this.root.innerHTML = `
      <div class="controls">
        <button class="primary" data-action="start">Start</button>
        <button class="ghost" data-action="stop" disabled>Stop</button>
        <label class="select">
          Encoder
          <select data-ref="encoder">
            <option value="pcm">PCM</option>
            <option value="opus">Opus (MediaRecorder)</option>
          </select>
        </label>
        <span class="badge badge-idle" data-ref="status">bereit</span>
      </div>
      <div class="meter" aria-label="Pegel">
        <div class="meter-bar" data-ref="bar"></div>
        <span class="meter-text" data-ref="level">– dB</span>
      </div>
      <div class="badges">
        <span class="badge badge-idle" data-ref="connection">getrennt</span>
        <span class="badge badge-idle" data-ref="stream">wartet</span>
        <span class="badge" data-ref="fallback">keine Fallbacks</span>
      </div>
      <pre class="status-box" data-ref="log"></pre>
    `;

    this.startButton = this.root.querySelector('[data-action="start"]');
    this.stopButton = this.root.querySelector('[data-action="stop"]');
    this.encoderSelect = this.root.querySelector('[data-ref="encoder"]');
    this.levelBar = this.root.querySelector('[data-ref="bar"]');
    this.levelText = this.root.querySelector('[data-ref="level"]');
    this.statusBox = this.root.querySelector('[data-ref="log"]');
    this.statusBadge = this.root.querySelector('[data-ref="status"]');
    this.connectionBadge = this.root.querySelector('[data-ref="connection"]');
    this.streamingBadge = this.root.querySelector('[data-ref="stream"]');
    this.fallbackBadge = this.root.querySelector('[data-ref="fallback"]');

    this.startButton.addEventListener('click', () => this.start());
    this.stopButton.addEventListener('click', () => this.stop());
  }
}

export function mountAudioWidget(selector = '#audio-widget', config = {}) {
  const root = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!root) throw new Error('Widget-Container nicht gefunden');
  return new AudioWidget(root, config);
}
