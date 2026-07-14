import { createRequire } from 'node:module';
import type { Connection } from 'mongoose';

const FUTURE_REFERENCE_TOLERANCE_MS = 60_000;

type CliOptions = {
  execute: boolean;
  allowFutureReference: boolean;
  referenceDate?: Date;
  maxWeeks?: number;
  lookbackWeeks?: number;
};

const parsePositiveInteger = (rawValue: string, optionName: string): number => {
  const parsedValue = Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`${optionName} phải là số nguyên dương`);
  }

  return parsedValue;
};

const parseArguments = (args: string[]): CliOptions => {
  const options: CliOptions = {
    execute: false,
    allowFutureReference: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case '--execute':
        options.execute = true;
        break;

      case '--allow-future-reference':
        options.allowFutureReference = true;
        break;

      case '--reference-date': {
        const rawValue = args[index + 1];

        if (!rawValue) {
          throw new Error('Thiếu giá trị cho --reference-date');
        }

        const parsedDate = new Date(rawValue);

        if (Number.isNaN(parsedDate.getTime())) {
          throw new Error('Ngày tham chiếu không hợp lệ');
        }

        options.referenceDate = parsedDate;
        index += 1;
        break;
      }

      case '--max-weeks': {
        const rawValue = args[index + 1];

        if (!rawValue) {
          throw new Error('Thiếu giá trị cho --max-weeks');
        }

        options.maxWeeks = parsePositiveInteger(rawValue, '--max-weeks');

        index += 1;
        break;
      }

      case '--lookback-weeks': {
        const rawValue = args[index + 1];

        if (!rawValue) {
          throw new Error('Thiếu giá trị cho --lookback-weeks');
        }

        options.lookbackWeeks = parsePositiveInteger(
          rawValue,
          '--lookback-weeks',
        );

        index += 1;
        break;
      }

      default:
        throw new Error(`Tham số không được hỗ trợ: ${argument}`);
    }
  }

  return options;
};

const validateReferenceDatePolicy = (options: CliOptions): void => {
  if (!options.referenceDate) {
    return;
  }

  const isFuture =
    options.referenceDate.getTime() >
    Date.now() + FUTURE_REFERENCE_TOLERANCE_MS;

  if (!isFuture) {
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Production không cho phép ngày tham chiếu trong tương lai',
    );
  }

  if (!options.allowFutureReference) {
    throw new Error(
      [
        'Ngày tham chiếu nằm trong tương lai.',
        'Thêm --allow-future-reference để xác nhận ở development/test.',
      ].join(' '),
    );
  }
};

const bootstrap = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));

  validateReferenceDatePolicy(options);

  if (!options.execute) {
    console.log(
      JSON.stringify(
        {
          success: true,
          executed: false,
          message:
            'Preview only: thêm --execute để kết nối database và chạy catch-up',
          options: {
            referenceDate: options.referenceDate?.toISOString() ?? null,
            maxWeeks: options.maxWeeks ?? 2,
            lookbackWeeks: options.lookbackWeeks ?? 52,
          },
        },
        null,
        2,
      ),
    );

    return;
  }

  const runtimeRequire = createRequire(__filename);

  const { NestFactory } = runtimeRequire(
    '@nestjs/core',
  ) as typeof import('@nestjs/core');
  const { getConnectionToken } = runtimeRequire(
    '@nestjs/mongoose',
  ) as typeof import('@nestjs/mongoose');
  const { AppModule } = runtimeRequire(
    '../app.module',
  ) as typeof import('../app.module');
  const { WeeklyRecapJobService } = runtimeRequire(
    '../modules/recap/services/weekly-recap-job.service',
  ) as typeof import('../modules/recap/services/weekly-recap-job.service');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());

    console.log(
      `[WeeklyRecapCatchUp] database=${
        connection.db?.databaseName ?? 'unknown'
      }`,
    );

    const service = app.get(WeeklyRecapJobService);

    const result = await service.runCatchUpForCompletedWeeks({
      referenceDate: options.referenceDate,
      maxWeeks: options.maxWeeks,
      lookbackWeeks: options.lookbackWeeks,
    });

    console.log(
      JSON.stringify(
        {
          executed: true,
          ...result,
        },
        null,
        2,
      ),
    );

    if (!result.success) {
      process.exitCode = 1;
      return;
    }

    if (result.truncatedByLookback) {
      console.warn(
        [
          'Còn backlog ngoài lookback.',
          `oldestUnresolvedWeekKey=${
            result.oldestUnresolvedWeekKey ?? 'unknown'
          }.`,
          'Hãy chạy lại với --lookback-weeks lớn hơn.',
        ].join(' '),
      );
    }
  } finally {
    await app.close();
  }
};

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));

  process.exitCode = 1;
});
