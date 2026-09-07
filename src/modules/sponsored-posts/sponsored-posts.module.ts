import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
    MongooseModule.forFeature([
      { name: SponsoredPost.name, schema: SponsoredPostSchema },
      { name: AdminAccount.name, schema: AdminAccountSchema },
      { name: AdminSession.name, schema: AdminSessionSchema },
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
    ]),
  ],
  providers: [
    ADMIN_POLICY_PROVIDER,
    AdminAuditService,
    SponsoredPostWriterService,
    { provide: SPONSORED_CLOCK, useValue: () => new Date() },
  ],
  exports: [SponsoredPostWriterService],
})
export class SponsoredPostsModule {}
