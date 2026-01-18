import { Injectable } from '@nestjs/common';

@Injectable()
export class PingService {
  ping(name?: string) {
    const suffix = name ? `, ${name}` : '';

    return {
      message: `pong${suffix}`,
      timestamp: new Date().toISOString(),
    };
  }
}

