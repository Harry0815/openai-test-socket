import { Module } from '@nestjs/common';
import { StaticController } from './controllers/static.controller';
import {
  FeatureTranslateModule,
} from '@ai-services/feature-translate';
import {
  FeatureSimultanDolmetscherModule,
} from '@ai-services/feature-simultan-dolmetscher';

@Module({
  imports: [
    FeatureTranslateModule,
    FeatureSimultanDolmetscherModule,
  ],
  controllers: [
    StaticController
  ],
  providers: [ ],
})
export class AppModule {}
