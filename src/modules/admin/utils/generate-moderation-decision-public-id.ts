import { customAlphabet } from 'nanoid';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const generateSuffix = customAlphabet(alphabet, 16);

export const generateModerationDecisionPublicId = (): string =>
  `mdec_${generateSuffix()}`;
