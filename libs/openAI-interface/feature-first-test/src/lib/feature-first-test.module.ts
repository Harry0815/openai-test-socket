import { Module } from '@nestjs/common';
import {
  AudioService,
  EchoService,
  HealthService,
  PingService,
  SocketLiveAudioService,
} from './services';
import { SocketioGateway } from './gateways/socket-io.gateway';

@Module({
  imports: [ ],
  controllers: [
  ],
  providers: [
    AudioService,
    EchoService,
    HealthService,
    PingService,
    SocketLiveAudioService,
    SocketioGateway
  ],
  exports: [
    AudioService,
    EchoService,
    HealthService,
    PingService,
    SocketLiveAudioService,
    SocketioGateway
  ]
})
export class FeatureFirstTestModule {}
