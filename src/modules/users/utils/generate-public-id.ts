import { customAlphabet } from 'nanoid';

const USER_PUBLIC_ID_PREFIX = 'usr_';
const USER_PUBLIC_ID_LENGTH = 10;

const PUBLIC_ID_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const generateNanoId = customAlphabet(
  PUBLIC_ID_ALPHABET,
  USER_PUBLIC_ID_LENGTH,
);

export function generateUserPublicId(): string {
  return `${USER_PUBLIC_ID_PREFIX}${generateNanoId()}`;
}
