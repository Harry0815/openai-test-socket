// audio-worklet.js
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.bufferSize = 0;

    this.port.onmessage = (e) => {
      const samples = e.data;
      if (samples && samples.length) {
        this.buffer.push(samples);
        this.bufferSize += samples.length;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);

    let offset = 0;

    while (this.buffer.length && offset < output.length) {
      const chunk = this.buffer[0];
      const remaining = output.length - offset;
      const toCopy = Math.min(chunk.length, remaining);

      output.set(chunk.subarray(0, toCopy), offset);

      if (toCopy < chunk.length) {
        this.buffer[0] = chunk.subarray(toCopy);
      } else {
        this.buffer.shift();
      }

      offset += toCopy;
      this.bufferSize -= toCopy;
    }

    return true;
  }
}

registerProcessor("pcm-player", PCMPlayerProcessor);
