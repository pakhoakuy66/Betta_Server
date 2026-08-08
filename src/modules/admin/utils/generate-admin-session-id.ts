import { randomBytes } from 'node:crypto';

const randomSuffix = (): string => randomBytes(18).toString('base64url');

export const generateAdminSessionPublicId = (): string =>
  `ases_${randomSuffix()}`;

export const generateAdminSessionFamily = (): string =>
  `afam_${randomSuffix()}`;
