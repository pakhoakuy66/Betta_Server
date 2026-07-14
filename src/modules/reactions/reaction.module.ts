import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReactionController } from './controllers/reaction.controller';
import { ReactionService } from './services/reaction.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecapModule } from '../recap/recap.module';
import { Reaction, ReactionSchema } from './schemas/reaction.schema';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Relationship,
  RelationshipSchema,
} from '../relationshipModule/schemas/relationship.schema';
import { Block, BlockSchema } from '../relationshipModule/schemas/block.schema';
import {
  WeeklyRecapRun,
  WeeklyRecapRunSchema,
} from '../recap/schemas/weekly-recap-run.schema';
import {
  ReactionCleanupCursor,
  ReactionCleanupCursorSchema,
} from './schemas/reaction-cleanup-cursor.schema';
import { ReactionCleanupService } from './services/reaction-cleanup.service';

@Module({
  imports: [
    NotificationsModule,
    RecapModule,
    MongooseModule.forFeature([
      { name: Reaction.name, schema: ReactionSchema },
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
      { name: Relationship.name, schema: RelationshipSchema },
      { name: Block.name, schema: BlockSchema },
      {
        name: WeeklyRecapRun.name,
        schema: WeeklyRecapRunSchema,
      },
      {
        name: ReactionCleanupCursor.name,
        schema: ReactionCleanupCursorSchema,
      },
    ]),
  ],
  controllers: [ReactionController],
  providers: [ReactionService, ReactionCleanupService],
  exports: [ReactionCleanupService],
})
export class ReactionModule {}
