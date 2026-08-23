import { customAlphabet } from 'nanoid';
import { ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN } from '../constants/access-support.constants';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const generate = customAlphabet(alphabet, 16);

export const generateSystemReportPublicId = (): string => `srep_${generate()}`;

export const isSystemReportPublicId = (value: unknown): value is string =>
  typeof value === 'string' &&
  ACCESS_SUPPORT_REPORT_PUBLIC_ID_PATTERN.test(value);
