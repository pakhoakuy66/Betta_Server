import { Module } from '@nestjs/common';
import { UploadsService } from './services/uploads.service';

@Module({
  providers: [UploadsService]
})
export class UploadsModule {}
