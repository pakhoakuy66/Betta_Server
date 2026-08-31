import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessSupportSecretsConfig } from './config/access-support-secrets.config';
import { AccessSupportCryptoService } from './services/access-support-crypto.service';

@Module({
  imports: [ConfigModule],
  providers: [AccessSupportSecretsConfig, AccessSupportCryptoService],
  exports: [AccessSupportCryptoService],
})
export class AccessSupportSecurityModule {}
