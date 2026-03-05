import { Module } from '@nestjs/common';
import { RecapService } from './services/recap.service';
import { RecapController } from './controllers/recap.controller';

@Module({
  providers: [RecapService],
  controllers: [RecapController]
})
export class RecapModule {}
