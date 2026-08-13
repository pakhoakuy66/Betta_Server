import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { createAdminPolicy } from '../config/admin-policy.config';
import { generateAdminActivationGrant } from '../utils/admin-activation-grant';
import { generateAdminPublicId } from '../utils/generate-admin-public-id';
import { AdminActivationService } from './admin-activation.service';

const policy = createAdminPolicy({ get: () => undefined });

const createService = () => {
  const loginProtection = {
    assertAllowed: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    recordFailure: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const service = new AdminActivationService(
    {} as never,
    {} as never,
    {} as never,
    policy,
    {} as never,
    loginProtection as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, loginProtection };
};

const validCompletion = () => ({
  adminPublicId: generateAdminPublicId(),
  activationGrant: generateAdminActivationGrant(),
  newPassword: 'A production password!2026',
  confirmPassword: 'A production password!2026',
  totpToken: '123456',
  trustedClientIp: '203.0.113.10',
});

describe('AdminActivationService input boundary', () => {
  it('rejects malformed activation credentials before persistence access', async () => {
    const { service, loginProtection } = createService();

    await expect(
      service.begin({
        adminPublicId: String(new Types.ObjectId()),
        activationGrant: 'not-a-grant',
        trustedClientIp: '203.0.113.10',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loginProtection.assertAllowed).not.toHaveBeenCalled();
  });

  it('rejects a mismatched password confirmation before rate-limit work', async () => {
    const { service, loginProtection } = createService();
    const input = validCompletion();

    await expect(
      service.complete({
        ...input,
        confirmPassword: 'Different password!2026',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(loginProtection.assertAllowed).not.toHaveBeenCalled();
  });

  it('rejects a weak password before rate-limit work', async () => {
    const { service, loginProtection } = createService();
    const input = validCompletion();

    await expect(
      service.complete({
        ...input,
        newPassword: 'weak-password',
        confirmPassword: 'weak-password',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(loginProtection.assertAllowed).not.toHaveBeenCalled();
  });
});
