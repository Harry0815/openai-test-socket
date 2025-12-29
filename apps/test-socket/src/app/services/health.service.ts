import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  getStatus(): { ok: boolean; timestamp: string } {
    return {
      ok: true,
      timestamp: new Date().toISOString(),
    };
  }
}
