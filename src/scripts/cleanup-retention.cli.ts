import type { CleanupMode } from '../modules/retention/retention.types';

export type RetentionCliOptions = {
  execute: boolean;
  mode: CleanupMode;
  maxDocuments?: number;
  confirmation?: string;
};

const parsePositiveInteger = (value: string, option: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} phải là số nguyên dương`);
  }
  return parsed;
};

const readValue = (args: string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Thiếu giá trị cho ${option}`);
  }
  return value;
};

export const parseRetentionArguments = (
  args: string[],
): RetentionCliOptions => {
  const options: RetentionCliOptions = { execute: false, mode: 'retention' };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--execute') {
      options.execute = true;
      continue;
    }
    if (argument === '--mode') {
      const value = readValue(args, index, argument);
      if (value !== 'retention' && value !== 'test-marker') {
        throw new Error('--mode chỉ nhận retention hoặc test-marker');
      }
      options.mode = value;
      index += 1;
      continue;
    }
    if (argument === '--max-documents') {
      options.maxDocuments = parsePositiveInteger(
        readValue(args, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument === '--confirm') {
      options.confirmation = readValue(args, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`Tham số không được hỗ trợ: ${argument}`);
  }

  return options;
};
