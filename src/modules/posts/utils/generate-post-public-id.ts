import { customAlphabet } from 'nanoid';

const POST_PUBLIC_ID_PREFIX = 'post_';
const POST_PUBLIC_ID_LENGTH = 12;

const PUBLIC_ID_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const generateNanoId = customAlphabet(
  PUBLIC_ID_ALPHABET,
  POST_PUBLIC_ID_LENGTH,
);

export function generatePostPublicId(): string {
  return `${POST_PUBLIC_ID_PREFIX}${generateNanoId()}`;
}
