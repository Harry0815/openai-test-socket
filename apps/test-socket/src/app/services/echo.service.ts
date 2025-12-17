import { Injectable } from '@nestjs/common';

@Injectable()
export class EchoService {
  echo(payload: unknown) {
    return {
      payload,
      receivedAt: new Date().toISOString(),
    };
  }
}
