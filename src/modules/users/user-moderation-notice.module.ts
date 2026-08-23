import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  UserModerationNotice,
  UserModerationNoticeSchema,
} from './schemas/user-moderation-notice.schema';
import { User, UserSchema } from './schemas/user.schema';
import {
  UserDeletionChangedHandler,
  UserRestrictionChangedHandler,
} from './services/user-moderation-notice.handlers';
import { UserModerationNoticeService } from './services/user-moderation-notice.service';

@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: UserModerationNotice.name, schema: UserModerationNoticeSchema },
    ]),
  ],
  providers: [
    UserModerationNoticeService,
    UserRestrictionChangedHandler,
    UserDeletionChangedHandler,
  ],
  exports: [UserModerationNoticeService],
})
export class UserModerationNoticeModule {}
