import { Transform } from 'node:stream';

export class FixedSizeChunker extends Transform {
  private buffer = Buffer.alloc(0);
  private readonly chunkSize: number;

  constructor(chunkSize: number) {
    super();
    this.chunkSize = chunkSize;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= this.chunkSize) {
      const slice = this.buffer.subarray(0, this.chunkSize);
      this.push(slice);
      this.buffer = this.buffer.subarray(this.chunkSize);
    }

    callback();
  }

  _flush(callback: (error?: Error | null) => void): void {
    if (this.buffer.length > 0) {
      this.push(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
    callback();
  }
}
