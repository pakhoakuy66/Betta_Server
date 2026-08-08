import { customAlphabet } from 'nanoid';

const PREFIX = 'aaud_';
const LENGTH = 16;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const generateNanoId = customAlphabet(ALPHABET, LENGTH);

export const generateAdminAuditPublicId = (): string =>
  `${PREFIX}${generateNanoId()}`;
