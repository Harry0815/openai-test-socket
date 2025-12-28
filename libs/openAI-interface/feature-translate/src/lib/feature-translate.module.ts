import { Module } from '@nestjs/common';
import { RealtimeGateway } from './gateways/realtime.gateway';

@Module({
  imports: [ ],
  controllers: [
  ],
  providers: [
    RealtimeGateway
  ],
  exports: [
    RealtimeGateway
  ]
})
export class FeatureTranslateModule {}
