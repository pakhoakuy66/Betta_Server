import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminBootstrapModule } from '../modules/admin/admin-bootstrap.module';
import {
  ADMIN_BOOTSTRAP_CONFIRMATION_ENV,
  ADMIN_BOOTSTRAP_CONFIRMATION_VALUE,
} from '../modules/admin/constants/admin-bootstrap.constants';
import { AdminBootstrapService } from '../modules/admin/services/admin-bootstrap.service';

const INPUT_ENV = {
  email: 'ADMIN_BOOTSTRAP_EMAIL',
  username: 'ADMIN_BOOTSTRAP_USERNAME',
  displayName: 'ADMIN_BOOTSTRAP_DISPLAY_NAME',
  operatorReference: 'ADMIN_BOOTSTRAP_OPERATOR_REFERENCE',
  correlationId: 'ADMIN_BOOTSTRAP_CORRELATION_ID',
} as const;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>('DATABASE_URL')?.trim();
        if (!uri) throw new Error('DATABASE_URL là bắt buộc');
        return { uri };
      },
    }),
    AdminBootstrapModule,
  ],
})
class AdminBootstrapCliModule {}

const readRequired = (config: ConfigService, key: string): string => {
  const value = config.get<string>(key)?.trim();
  if (!value) throw new Error(`${key} là bắt buộc`);
  return value;
};

const parseArguments = (): Readonly<{
  execute: boolean;
  reissue: boolean;
}> => {
  const args = new Set(process.argv.slice(2));
  for (const argument of args) {
    if (argument !== '--execute' && argument !== '--reissue') {
      throw new Error('Lệnh bootstrap chứa tham số không được hỗ trợ');
    }
  }
  if (args.has('--reissue') && !args.has('--execute')) {
    throw new Error('--reissue chỉ hợp lệ cùng --execute');
  }
  return Object.freeze({
    execute: args.has('--execute'),
    reissue: args.has('--reissue'),
  });
};

const run = async (): Promise<void> => {
  const arguments_ = parseArguments();
  const application = await NestFactory.createApplicationContext(
    AdminBootstrapCliModule,
    { logger: false },
  );

  try {
    const config = application.get(ConfigService);
    if (
      arguments_.execute &&
      config.get<string>('NODE_ENV')?.trim() === 'production' &&
      config.get<string>(ADMIN_BOOTSTRAP_CONFIRMATION_ENV)?.trim() !==
        ADMIN_BOOTSTRAP_CONFIRMATION_VALUE
    ) {
      throw new Error(
        `${ADMIN_BOOTSTRAP_CONFIRMATION_ENV}=YES là bắt buộc trong production`,
      );
    }

    const correlationId = config.get<string>(INPUT_ENV.correlationId)?.trim();
    const request = {
      identity: {
        email: readRequired(config, INPUT_ENV.email),
        username: readRequired(config, INPUT_ENV.username),
        displayName: readRequired(config, INPUT_ENV.displayName),
      },
      operatorReference: readRequired(config, INPUT_ENV.operatorReference),
      ...(correlationId ? { correlationId } : {}),
      reissue: arguments_.reissue,
    } as const;
    const service = application.get(AdminBootstrapService);
    const result = arguments_.execute
      ? await service.execute(request)
      : await service.inspect(request);
    const output =
      arguments_.execute && result.secretReference && result.expiresAt
        ? {
            secretReference: result.secretReference,
            expiresAt: result.expiresAt,
          }
        : { outcome: result.outcome };

    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    await application.close();
  }
};

void run().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Admin bootstrap thất bại';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
