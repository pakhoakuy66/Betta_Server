import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CloudinaryAssetHealthService } from './services/cloudinary-asset-health.service';
import { UploadsService } from './services/uploads.service';

@Module({
  imports: [ConfigModule],
  providers: [UploadsService, CloudinaryAssetHealthService],
  exports: [UploadsService, CloudinaryAssetHealthService],
})
export class UploadsModule {}
