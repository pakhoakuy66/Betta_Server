import { SponsoredSchedulerStore } from './sponsored-scheduler.store';
import { SponsoredSchedulerService } from './sponsored-scheduler.service';
import { SponsoredActivationService } from './sponsored-activation.service';
import { SponsoredLifecycleService } from './sponsored-lifecycle.service';
import { SponsoredPostMutationService } from './sponsored-post-mutation.service';
import {
  SponsoredMutationReceipt,
  SponsoredMutationReceiptSchema,
} from './sponsored-mutation-receipt.schema';
import { Module } from '@nestjs/common';
import { SponsoredPostQueryService } from './sponsored-post-query.service';
import { ConfigModule } from '@nestjs/config';
import { OutboxModule } from '../../common/outbox/outbox.module';
import {
  SponsoredMediaAsset,
  SponsoredMediaAssetSchema,
} from './sponsored-media-asset.schema';
import { SponsoredMediaCloudService } from './sponsored-media-cloud.service';
import { SponsoredMediaService } from './sponsored-media.service';
import { SponsoredMediaCleanupHandler } from './sponsored-media-cleanup.handler';
import { SponsoredMediaHealthService } from './sponsored-media-health.service';
import { MongooseModule } from '@nestjs/mongoose';
import { ADMIN_POLICY_PROVIDER } from '../admin/config/admin-policy.config';
import {
  AdminAccount,
  AdminAccountSchema,
} from '../admin/schemas/admin-account.schema';
import {
  AdminSession,
  AdminSessionSchema,
} from '../admin/schemas/admin-session.schema';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../admin/schemas/admin-audit-event.schema';
import { AdminAuditService } from '../admin/services/admin-audit.service';
import { SPONSORED_CLOCK } from './sponsored-post.constants';
import { SponsoredPost, SponsoredPostSchema } from './sponsored-post.schema';
import { SponsoredPostWriterService } from './sponsored-post-writer.service';

@Module({
  imports: [
    ConfigModule,
    OutboxModule,
    MongooseModule.forFeature([
      {
        name: SponsoredMutationReceipt.name,
        schema: SponsoredMutationReceiptSchema,
      },
      { name: SponsoredPost.name, schema: SponsoredPostSchema },
      { name: SponsoredMediaAsset.name, schema: SponsoredMediaAssetSchema },
      { name: AdminAccount.name, schema: AdminAccountSchema },
      { name: AdminSession.name, schema: AdminSessionSchema },
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
    ]),
  ],
  providers: [
    SponsoredSchedulerStore,
    SponsoredSchedulerService,
    SponsoredActivationService,
    SponsoredLifecycleService,
    SponsoredPostMutationService,
    SponsoredPostQueryService,
    ADMIN_POLICY_PROVIDER,
    AdminAuditService,
    SponsoredPostWriterService,
    SponsoredMediaCloudService,
    SponsoredMediaService,
    SponsoredMediaCleanupHandler,
    SponsoredMediaHealthService,
    { provide: SPONSORED_CLOCK, useValue: () => new Date() },
  ],
  exports: [
    SponsoredSchedulerStore,
    SponsoredSchedulerService,
    SponsoredLifecycleService,
    SponsoredPostMutationService,
    SponsoredPostQueryService,
    SponsoredPostWriterService,
    SponsoredMediaService,
    SponsoredMediaHealthService,
  ],
})
export class SponsoredPostsModule {}
