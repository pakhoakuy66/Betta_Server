import { Module } from '@nestjs/common';
import { SponsoredDeliveryStore } from './sponsored-delivery.store';

/** Import from the Home Feed orchestrator in Task05; no new HTTP route. */
@Module({
  providers: [SponsoredDeliveryStore],
  exports: [SponsoredDeliveryStore],
})
export class SponsoredDeliveryModule {}
