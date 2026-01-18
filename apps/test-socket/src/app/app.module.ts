import { Module } from '@nestjs/common';
import { StaticController } from './controllers/static.controller';
import {
  FeatureTranslateModule,
} from '@ai-services/feature-translate';
import {
  FeatureFirstTestModule,
} from '@ai-services/feature-first-test';

@Module({
  imports: [
    FeatureTranslateModule,
    FeatureFirstTestModule,
  ],
  controllers: [
    StaticController
  ],
  providers: [ ],
})
export class AppModule {}
