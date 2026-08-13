import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  ADMIN_BREAK_GLASS_CONFIRMATION_ENV,
  ADMIN_BREAK_GLASS_CONFIRMATION_VALUE,
} from '../modules/admin/constants/admin-account-recovery.constants';
import { AdminAccountRecoveryService } from '../modules/admin/services/admin-account-recovery.service';

const readRequired = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} là bắt buộc`);
  return value;
};

const main = async (): Promise<void> => {
  const execute = process.argv.slice(2).includes('--execute');
  const request = {
    targetAdminPublicId: readRequired('ADMIN_BREAK_GLASS_TARGET_PUBLIC_ID'),
    operatorReference: readRequired('ADMIN_BREAK_GLASS_OPERATOR_REFERENCE'),
    approvalReference: readRequired('ADMIN_BREAK_GLASS_APPROVAL_REFERENCE'),
    correlationId: process.env.ADMIN_BREAK_GLASS_CORRELATION_ID?.trim(),
  };
  if (
    execute &&
    process.env[ADMIN_BREAK_GLASS_CONFIRMATION_ENV] !==
      ADMIN_BREAK_GLASS_CONFIRMATION_VALUE
  ) {
    throw new Error(
      `${ADMIN_BREAK_GLASS_CONFIRMATION_ENV}=YES là bắt buộc khi execute`,
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const service = app.get(AdminAccountRecoveryService);
    const result = execute
      ? await service.executeBreakGlass(request)
      : await service.inspectBreakGlass(request);
    process.stdout.write(
      `${JSON.stringify({ mode: execute ? 'execute' : 'dry-run', ...result }, null, 2)}\n`,
    );
  } finally {
    await app.close();
  }
};

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Break-glass thất bại';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
