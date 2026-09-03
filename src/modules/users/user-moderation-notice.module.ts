import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  AuthSession,
  AuthSessionSchema,
} from '../auth/schemas/auth-session.schema';
import { Post, PostSchema } from '../posts/schemas/post.schema';
import {
  UserModerationNotice,
  UserModerationNoticeSchema,
} from './schemas/user-moderation-notice.schema';
import { User, UserSchema } from './schemas/user.schema';
import {
  UserDeletionChangedHandler,
  UserDeletionSessionRevocationHandler,
  PostModerationChangedHandler,
  UserRestrictionChangedHandler,
  UserRestrictionSessionRevocationHandler,
} from './services/user-moderation-notice.handlers';
import { UserModerationNoticeService } from './services/user-moderation-notice.service';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AuthSession.name, schema: AuthSessionSchema },
      { name: Post.name, schema: PostSchema },
      { name: UserModerationNotice.name, schema: UserModerationNoticeSchema },
    ]),
  ],
  providers: [
    UserModerationNoticeService,
    UserRestrictionChangedHandler,
    UserRestrictionSessionRevocationHandler,
    UserDeletionChangedHandler,
    UserDeletionSessionRevocationHandler,
    PostModerationChangedHandler,
  ],
  exports: [UserModerationNoticeService],
})
export class UserModerationNoticeModule {}
