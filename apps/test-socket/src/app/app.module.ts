import { Module } from '@nestjs/common';
import { PingController } from './controllers/ping.controller';
import { HealthController } from './controllers/health.controller';
import { EchoController } from './controllers/echo.controller';
import { StaticController } from './controllers/static.controller';
import { PingService } from './services/ping.service';
import { HealthService } from './services/health.service';
import { EchoService } from './services/echo.service';
// import { SocketioGateway } from './gateway/socket-io.gateway';
import { OwnAudioService } from './services/audio.service';
import { AudioRecordingService } from './services/recording.service';
import { SocketLiveAudioService } from './services/live-audio.service';
// import { OwnWebSocketGateway } from './gateway/websocket.gateway';
import { SocketIoZweiGateway } from './gateway/socket-io-zwei.gateway';

@Module({
  imports: [ ],
  controllers: [
    PingController,
    HealthController,
    EchoController,
    StaticController
  ],
  providers: [
    PingService,
    HealthService,
    EchoService,
    OwnAudioService,
    AudioRecordingService,
    // SocketioGateway,
    // OwnWebSocketGateway,
    SocketIoZweiGateway,
    SocketLiveAudioService
  ],
})
export class AppModule {}
