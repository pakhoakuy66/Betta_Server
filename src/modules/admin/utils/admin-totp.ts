import { createHmac, timingSafeEqual } from 'node:crypto';
import { ADMIN_TOTP_TOKEN_PATTERN } from '../constants/admin-mfa.constants';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const encodeAdminTotpSecret = (secret: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

export const adminTotpStep = (date: Date, periodSeconds: number): number =>
  Math.floor(date.getTime() / 1000 / periodSeconds);

export const createAdminTotp = (
  secret: Buffer,
  step: number,
  digits: number,
): string => {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new TypeError('TOTP time-step không hợp lệ');
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
};

export const findMatchingAdminTotpStep = (input: {
  secret: Buffer;
  token: unknown;
  now: Date;
  periodSeconds: number;
  digits: number;
  acceptedPastSteps: number;
  acceptedFutureSteps: number;
}): number | null => {
  if (
    typeof input.token !== 'string' ||
    !ADMIN_TOTP_TOKEN_PATTERN.test(input.token)
  ) {
    return null;
  }
  const current = adminTotpStep(input.now, input.periodSeconds);
  const received = Buffer.from(input.token, 'ascii');

  for (
    let step = current - input.acceptedPastSteps;
    step <= current + input.acceptedFutureSteps;
    step += 1
  ) {
    if (step < 0) continue;
    const expected = Buffer.from(
      createAdminTotp(input.secret, step, input.digits),
      'ascii',
    );
    if (timingSafeEqual(received, expected)) return step;
  }
  return null;
};
