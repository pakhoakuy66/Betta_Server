import { customAlphabet } from 'nanoid';
import {
  REPORT_PUBLIC_ID_ALPHABET,
  REPORT_PUBLIC_ID_LENGTH,
  REPORT_PUBLIC_ID_PATTERN,
  REPORT_PUBLIC_ID_PREFIX,
} from '../constants/report-queue.constants';

const generate = customAlphabet(
  REPORT_PUBLIC_ID_ALPHABET,
  REPORT_PUBLIC_ID_LENGTH,
);

export const generateReportPublicId = (): string =>
  `${REPORT_PUBLIC_ID_PREFIX}${generate()}`;

export const isReportPublicId = (value: unknown): value is string =>
  typeof value === 'string' && REPORT_PUBLIC_ID_PATTERN.test(value);
