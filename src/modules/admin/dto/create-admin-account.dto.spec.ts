import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from '@jest/globals';
import { CreateAdminAccountDto } from './create-admin-account.dto';

const source = () => ({
  email: ' NEW.ADMIN@BETTA.TEST ',
  username: ' New.Admin ',
  displayName: ' New Admin ',
  reauthGrant: 'A'.repeat(43),
  reasonCode: 'team_capacity',
});

describe('CreateAdminAccountDto', () => {
  it('normalizes identity at the HTTP boundary', async () => {
    const dto = plainToInstance(CreateAdminAccountDto, source());

    await expect(
      validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).resolves.toHaveLength(0);
    expect(dto).toMatchObject({
      email: 'new.admin@betta.test',
      username: 'new.admin',
      displayName: 'New Admin',
    });
  });

  it.each(['role', 'permissions'])(
    'rejects injected %s instead of accepting privilege input',
    async (field) => {
      const dto = plainToInstance(CreateAdminAccountDto, {
        ...source(),
        [field]: field === 'role' ? 'SUPER_ADMIN' : ['admins.create'],
      });

      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      expect(errors.some(({ property }) => property === field)).toBe(true);
    },
  );
});
