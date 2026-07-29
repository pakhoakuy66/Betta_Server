import { customAlphabet } from 'nanoid';

const PREFIX = 'noti_';
const LENGTH = 16;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const generateNanoId = customAlphabet(ALPHABET, LENGTH);

const PATTERN = new RegExp(`^${PREFIX}[${ALPHABET}]{${LENGTH}}$`);

export function generateNotificationPublicId(): string {
  return `${PREFIX}${generateNanoId()}`;
}

export function isValidNotificationPublicId(value: unknown): value is string {
  return typeof value === 'string' && PATTERN.test(value);
}
