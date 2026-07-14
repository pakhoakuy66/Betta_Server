import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../app.module';
import { ReactionCleanupService } from '../modules/reactions/services/reaction-cleanup.service';

const SUPPORTED_FLAGS = new Set(['--execute']);
const SUPPORTED_OPTIONS = new Set([
  'batch-size',
  'max-weeks',
  'now',
  'confirm-production',
]);

const parsePositiveInteger = (
  name: string,
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined) return fallback;

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} không hợp lệ`);
  }

  return value;
};

const parseArguments = () => {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith('--')) {
      throw new Error(`Argument không được hỗ trợ: ${argument}`);
    }

    if (!argument.includes('=')) {
      if (!SUPPORTED_FLAGS.has(argument)) {
        throw new Error(`Flag không được hỗ trợ: ${argument}`);
      }

      if (flags.has(argument)) {
        throw new Error(`Flag bị lặp: ${argument}`);
      }

      flags.add(argument);
      continue;
    }

    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);

    if (!SUPPORTED_OPTIONS.has(name)) {
      throw new Error(`Option không được hỗ trợ: --${name}`);
    }

    if (values.has(name)) {
      throw new Error(`Option bị lặp: --${name}`);
    }

    if (!value.trim()) {
      throw new Error(`Option --${name} không được để trống`);
    }

    values.set(name, value);
  }

  const rawNow = values.get('now');
  const now = rawNow ? new Date(rawNow) : new Date();

  if (Number.isNaN(now.getTime())) {
    throw new Error('--now không hợp lệ');
  }

  return {
    execute: flags.has('--execute'),
    now,
    batchSize: parsePositiveInteger(
      'batch-size',
      values.get('batch-size'),
      500,
    ),
    maxWeeks: parsePositiveInteger('max-weeks', values.get('max-weeks'), 20),
    productionConfirmation: values.get('confirm-production'),
  };
};

const bootstrap = async (): Promise<void> => {
  const options = parseArguments();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());
    const service = app.get(ReactionCleanupService);

    console.log(
      `[ReactionCleanup] database=${
        connection.db?.databaseName ?? 'unknown'
      } execute=${options.execute}`,
    );

    const result = await service.cleanupEligibleReactions(options);

    console.log(JSON.stringify(result, null, 2));

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
};

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));

  process.exitCode = 1;
});
