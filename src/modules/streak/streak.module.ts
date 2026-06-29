import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { StreakHistory, StreakHistorySchema } from './schemas/streak.schema';
import { StreakService } from './services/streak.service';
import { StreakController } from './controllers/streak.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: StreakHistory.name, schema: StreakHistorySchema },
    ]),
  ],
  providers: [StreakService],
  controllers: [StreakController],
  exports: [StreakService],
})
export class StreakModule {}
