import { Module } from '@nestjs/common';
import { PingController } from './controllers/ping.controller';
import { HealthController } from './controllers/health.controller';
import { EchoController } from './controllers/echo.controller';
import { StaticController } from './controllers/static.controller';
import { PingService } from './services/ping.service';
import { HealthService } from './services/health.service';
import { EchoService } from './services/echo.service';
import { AudioService } from './services/audio.service';
import { AudioRecordingService } from './services/recording.service';
import { SocketLiveAudioService } from './services/live-audio.service';
import {
  FeatureTranslateModule,
} from '@test-socket/feature-translate';

@Module({
  imports: [
    FeatureTranslateModule
  ],
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
    AudioService,
    AudioRecordingService,
    SocketLiveAudioService,
  ],
})
export class AppModule {}
