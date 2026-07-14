import { NestFactory } from '@nestjs/core';
import { RetentionCliModule } from '../modules/retention/retention-cli.module';
import { DataRetentionService } from '../modules/retention/data-retention.service';
import { parseRetentionArguments } from './cleanup-retention.cli';

const bootstrap = async (): Promise<void> => {
  const options = parseRetentionArguments(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(RetentionCliModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const service = app.get(DataRetentionService);
    const result = await service.run(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  } finally {
    await app.close();
  }
};

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
