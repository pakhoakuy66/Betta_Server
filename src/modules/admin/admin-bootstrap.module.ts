import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin.module';
import { AdminBootstrapService } from './services/admin-bootstrap.service';

@Module({
  imports: [ConfigModule, AdminModule],
  providers: [AdminBootstrapService],
  exports: [AdminBootstrapService],
})
export class AdminBootstrapModule {}
