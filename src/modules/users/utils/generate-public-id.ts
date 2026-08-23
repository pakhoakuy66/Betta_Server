import { customAlphabet } from 'nanoid';

export const USER_PUBLIC_ID_PREFIX = 'usr_';
export const USER_PUBLIC_ID_LENGTH = 10;

export const USER_PUBLIC_ID_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const USER_PUBLIC_ID_PATTERN = new RegExp(
  `^${USER_PUBLIC_ID_PREFIX}[${USER_PUBLIC_ID_ALPHABET}]{${USER_PUBLIC_ID_LENGTH}}$`,
);

const generateNanoId = customAlphabet(
  USER_PUBLIC_ID_ALPHABET,
  USER_PUBLIC_ID_LENGTH,
);

export function generateUserPublicId(): string {
  return `${USER_PUBLIC_ID_PREFIX}${generateNanoId()}`;
}
