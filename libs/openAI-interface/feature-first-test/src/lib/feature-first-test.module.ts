import { Module } from '@nestjs/common';
import {
  AudioService,
  EchoService,
  HealthService,
  PingService,
  SocketLiveAudioService,
} from './services';
import { SocketioGateway } from './gateways/socket-io.gateway';
import { PingController, HealthController, EchoController } from './controllers';

@Module({
  imports: [ ],
  controllers: [
    PingController,
    HealthController,
    EchoController
  ],
  providers: [
    AudioService,
    EchoService,
    HealthService,
    PingService,
    SocketLiveAudioService,
    SocketioGateway
  ],
  exports: [ ]
})
export class FeatureFirstTestModule {}
