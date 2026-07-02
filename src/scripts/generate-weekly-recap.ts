import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../app.module';
import { RecapService } from '../modules/recap/services/recap.service';
import { getRecapWeekRange } from '../modules/recap/utils/recap-week.util';

const parseReferenceDate = (): Date => {
  const rawValue = process.argv[2];

  if (!rawValue) return new Date();

  const parsedDate = new Date(rawValue);

  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`Invalid reference date: ${rawValue}`);
  }

  return parsedDate;
};

const bootstrap = async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());

    console.log(
      `[WeeklyRecap] database=${connection.db?.databaseName ?? 'unknown'}`,
    );

    const recapService = app.get(RecapService);
    const referenceDate = parseReferenceDate();
    const { weekStart } = getRecapWeekRange(referenceDate);

    const result = await recapService.aggregateWeeklyRecap({ weekStart });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
};

void bootstrap();
