import { Module } from '@nestjs/common';
import { PingController } from './controllers/ping.controller';
import { HealthController } from './controllers/health.controller';
import { EchoController } from './controllers/echo.controller';
import { StaticController } from './controllers/static.controller';
import {
  FeatureTranslateModule,
} from '@test-socket/feature-translate';
import {
  FeatureFirstTestModule,
} from '@test-socket/feature-first-test';

@Module({
  imports: [
    FeatureTranslateModule,
    FeatureFirstTestModule,
  ],
  controllers: [
    PingController,
    HealthController,
    EchoController,
    StaticController
  ],
  providers: [ ],
})
export class AppModule {}
