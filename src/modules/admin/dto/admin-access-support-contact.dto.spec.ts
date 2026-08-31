import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import {
  AdminAccessSupportContactParamDto,
  IssueAdminAccessSupportContactReauthDto,
  RevealAdminAccessSupportContactDto,
} from './admin-access-support-contact.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validate = <T extends object>(
  value: unknown,
  metatype: new () => T,
  type: 'body' | 'param' = 'body',
): Promise<T> => pipe.transform(value, { type, metatype }) as Promise<T>;

describe('Admin access-support contact DTO', () => {
  it('accepts only an access-support SystemReport public ID', async () => {
    await expect(
      validate(
        { publicId: 'srep_23456789ABCDEFGH' },
        AdminAccessSupportContactParamDto,
        'param',
      ),
    ).resolves.toEqual({ publicId: 'srep_23456789ABCDEFGH' });
    await expect(
      validate(
        { publicId: 'rpt_23456789ABCDEFGH' },
        AdminAccessSupportContactParamDto,
        'param',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires password and a six-digit TOTP for re-auth', async () => {
    await expect(
      validate(
        { password: 'StrongPassword!1', totpToken: '123456' },
        IssueAdminAccessSupportContactReauthDto,
      ),
    ).resolves.toEqual({
      password: 'StrongPassword!1',
      totpToken: '123456',
    });
    await expect(
      validate(
        { password: 'StrongPassword!1', totpToken: '12345x' },
        IssueAdminAccessSupportContactReauthDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalizes a safe mandatory reason and rejects sensitive or extra data', async () => {
    const valid = {
      reauthGrant: 'A'.repeat(43),
      reason: '  Support_Follow_Up  ',
      correlationId: 'corr_mod10_reveal_20260830_0001',
    };
    await expect(
      validate(valid, RevealAdminAccessSupportContactDto),
    ).resolves.toEqual({
      ...valid,
      reason: 'support_follow_up',
    });
    await expect(
      validate(
        { ...valid, reason: 'private.person@example.com' },
        RevealAdminAccessSupportContactDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(
        { ...valid, contactEmail: 'private.person@example.com' },
        RevealAdminAccessSupportContactDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
