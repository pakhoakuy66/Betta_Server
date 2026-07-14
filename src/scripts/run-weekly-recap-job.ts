import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../app.module';
import { WeeklyRecapJobService } from '../modules/recap/services/weekly-recap-job.service';

const FORCE_FLAG = '--force';

const getScriptArgs = (): string[] => process.argv.slice(2);

const parseReferenceDate = (): Date => {
  const rawValue = getScriptArgs().find(
    (value) => value !== FORCE_FLAG && !value.startsWith('--'),
  );

  if (!rawValue) return new Date();

  const parsedDate = new Date(rawValue);

  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`Invalid reference date: ${rawValue}`);
  }

  return parsedDate;
};

const shouldForceRerun = (): boolean => getScriptArgs().includes(FORCE_FLAG);

const bootstrap = async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());

    console.log(
      `[WeeklyRecapJob] database=${connection.db?.databaseName ?? 'unknown'}`,
    );

    const weeklyRecapJobService = app.get(WeeklyRecapJobService);
    const referenceDate = parseReferenceDate();

    const result = await weeklyRecapJobService.runForPreviousCompletedWeek(
      referenceDate,
      { force: shouldForceRerun() },
    );

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
};

void bootstrap();
