import { customAlphabet } from 'nanoid';

const generate = customAlphabet(
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  22,
);

export const generateUserModerationNoticePublicId = (): string =>
  `mnot_${generate()}`;

export const generateModerationSupportReference = (): string =>
  `sup_${generate()}`;
