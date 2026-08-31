import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { AccessSupportRequestDto } from './access-support-request.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validate = (value: unknown): Promise<AccessSupportRequestDto> =>
  pipe.transform(value, {
    type: 'body',
    metatype: AccessSupportRequestDto,
  }) as Promise<AccessSupportRequestDto>;

const validPayload = {
  category: 'LOGIN_PROBLEM',
  contactEmail: ' Person@Example.com ',
  description: ' Tôi không thể đăng nhập vào tài khoản từ sáng nay. ',
  accountEmailOrUsername: ' person ',
  correlationId: 'corr-adm-mod-07-0001',
};

describe('AccessSupportRequestDto', () => {
  it('normalizes only the allowlisted JSON fields', async () => {
    await expect(validate(validPayload)).resolves.toEqual({
      category: 'LOGIN_PROBLEM',
      contactEmail: 'person@example.com',
      description: 'Tôi không thể đăng nhập vào tài khoản từ sáng nay.',
      accountEmailOrUsername: 'person',
      correlationId: 'corr-adm-mod-07-0001',
    });
  });

  it('rejects unknown fields instead of silently accepting files or flags', async () => {
    await expect(
      validate({ ...validPayload, evidence: 'data:image/png;base64,AAAA' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    { category: 'NOT_ALLOWED' },
    { description: 'quá ngắn' },
    { description: 'x'.repeat(2001) },
    { contactEmail: 'not-an-email' },
    { accountEmailOrUsername: null },
    { correlationId: null },
    { correlationId: 'bad correlation id' },
  ])('rejects payload outside the locked contract: %o', async (override) => {
    await expect(
      validate({ ...validPayload, ...override }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
