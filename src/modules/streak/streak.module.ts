import { Module } from '@nestjs/common';
import { StreakService } from './services/streak.service';
import { StreakController } from './controllers/streak.controller';

@Module({
  providers: [StreakService],
  controllers: [StreakController]
})
export class StreakModule {}
