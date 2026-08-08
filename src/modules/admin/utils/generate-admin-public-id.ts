import { customAlphabet } from 'nanoid';

export const ADMIN_PUBLIC_ID_PREFIX = 'adm_';
export const ADMIN_PUBLIC_ID_LENGTH = 12;
export const ADMIN_PUBLIC_ID_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const generateNanoId = customAlphabet(
  ADMIN_PUBLIC_ID_ALPHABET,
  ADMIN_PUBLIC_ID_LENGTH,
);

export const ADMIN_PUBLIC_ID_PATTERN = new RegExp(
  `^${ADMIN_PUBLIC_ID_PREFIX}` +
    `[${ADMIN_PUBLIC_ID_ALPHABET}]{${ADMIN_PUBLIC_ID_LENGTH}}$`,
);

export function generateAdminPublicId(): string {
  return `${ADMIN_PUBLIC_ID_PREFIX}${generateNanoId()}`;
}

export function isValidAdminPublicId(value: unknown): value is string {
  return typeof value === 'string' && ADMIN_PUBLIC_ID_PATTERN.test(value);
}
