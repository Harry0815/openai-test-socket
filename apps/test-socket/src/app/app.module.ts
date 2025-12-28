import { Module } from '@nestjs/common';
import {
  FeatureTranslateModule,
} from '@test-socket/feature-translate';
import { FeatureFirstTestsModule } from '@test-socket/feature-first-tests';

@Module({
  imports: [
    FeatureTranslateModule,
    FeatureFirstTestsModule
  ],
  controllers: [
  ],
  providers: [
  ],
})
export class AppModule {}
