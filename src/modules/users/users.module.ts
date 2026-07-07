import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './services/users.service';
import { UsersController } from './controllers/users.controller';
import { UploadsModule } from '../uploads/uploads.module';
import { User, UserSchema } from './schemas/user.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../relationshipModule/schemas/relationship.schema';
import { Block, BlockSchema } from '../relationshipModule/schemas/block.schema';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { Reaction, ReactionSchema } from '../reactions/schemas/reaction.schema';
import { PostShare, PostShareSchema } from '../posts/schemas/post-share.schema';
import {
  Notification,
  NotificationSchema,
} from '../notifications/schemas/notifications.schema';
import {
  EngagementEvent,
  EngagementEventSchema,
} from '../recap/schemas/engagement-event.schema';
import { WeeklyRecap, WeeklyRecapSchema } from '../recap/schemas/recap.schema';
import {
  StreakHistory,
  StreakHistorySchema,
} from '../streak/schemas/streak.schema';
import {
  ReportCooldown,
  ReportCooldownSchema,
} from '../reports/schemas/report-cooldown.schema';

@Module({
  imports: [
    UploadsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Relationship.name, schema: RelationshipSchema },
      { name: Block.name, schema: BlockSchema },
      { name: Post.name, schema: PostSchema },
      { name: Reaction.name, schema: ReactionSchema },
      { name: PostShare.name, schema: PostShareSchema },
      { name: Notification.name, schema: NotificationSchema },
      { name: EngagementEvent.name, schema: EngagementEventSchema },
      { name: WeeklyRecap.name, schema: WeeklyRecapSchema },
      { name: StreakHistory.name, schema: StreakHistorySchema },
      { name: ReportCooldown.name, schema: ReportCooldownSchema },
    ]),
  ],
  exports: [MongooseModule],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
