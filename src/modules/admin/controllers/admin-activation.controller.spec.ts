import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { createAdminPolicy } from '../config/admin-policy.config';
import { AdminRole } from '../constants/admin-account.constants';
import type { AdminActivationService } from '../services/admin-activation.service';
import type { AdminAuthCookieService } from '../services/admin-auth-cookie.service';
import { AdminActivationController } from './admin-activation.controller';

const policy = createAdminPolicy({ get: () => undefined });
const adminPublicId = 'adm_23456789ABCD';
const rawGrant = 'A'.repeat(43);

const response = () => {
  const setHeader = jest.fn();
  return {
    value: { setHeader } as unknown as Response,
    setHeader,
  };
};

const request = () =>
  ({
    ip: '203.0.113.10',
    socket: {},
    get: jest
      .fn<(name: string) => string | undefined>()
      .mockReturnValue('Chrome on Windows'),
  }) as unknown as Request;

describe('AdminActivationController', () => {
  it('returns a challenge with no-store headers', async () => {
    const challenge = {
      admin: {
        publicId: adminPublicId,
        username: 'root.admin',
        displayName: 'Root Admin',
      },
      secretBase32: 'A'.repeat(32),
      otpauthUri: 'otpauth://totp/Betta%3Aroot.admin?secret=AAAA',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const activation = {
      begin: jest
        .fn<() => Promise<typeof challenge>>()
        .mockResolvedValue(challenge),
    };
    const controller = new AdminActivationController(
      activation as unknown as AdminActivationService,
      {} as AdminAuthCookieService,
      policy,
    );
    const res = response();

    await expect(
      controller.start(
        { adminPublicId, activationGrant: rawGrant },
        request(),
        res.value,
      ),
    ).resolves.toBe(challenge);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
  });

  it('writes cookies and never serializes the refresh credential', async () => {
    const authentication = {
      accessToken: 'access-token',
      refreshToken: 'refresh-secret',
      refreshTokenExpiresAt: new Date(Date.now() + 60_000),
      sessionPublicId: 'ases_23456789ABCDEFGH',
      admin: {
        id: adminPublicId,
        publicId: adminPublicId,
        username: 'root.admin',
        displayName: 'Root Admin',
        role: AdminRole.SUPER_ADMIN,
      },
    };
    const activation = {
      complete: jest
        .fn<
          () => Promise<{
            authentication: typeof authentication;
            recoveryCodes: string[];
          }>
        >()
        .mockResolvedValue({ authentication, recoveryCodes: ['recovery-one'] }),
    };
    const cookies = {
      writeSession: jest.fn().mockReturnValue('csrf-proof'),
    };
    const controller = new AdminActivationController(
      activation as unknown as AdminActivationService,
      cookies as unknown as AdminAuthCookieService,
      policy,
    );

    const result = await controller.complete(
      {
        adminPublicId,
        activationGrant: rawGrant,
        newPassword: 'A production password!2026',
        confirmPassword: 'A production password!2026',
        totpToken: '123456',
      },
      request(),
      response().value,
    );

    const writeSession = cookies.writeSession as jest.Mock;
    expect(writeSession).toHaveBeenCalledWith(
      expect.anything(),
      authentication,
    );
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
    expect(result).toEqual(
      expect.objectContaining({
        accessToken: 'access-token',
        csrfToken: 'csrf-proof',
        recoveryCodes: ['recovery-one'],
      }),
    );
  });

  it('sets no-store headers even when activation fails', async () => {
    const activation = {
      begin: jest
        .fn<() => Promise<never>>()
        .mockRejectedValue(new ServiceUnavailableException()),
    };
    const controller = new AdminActivationController(
      activation as unknown as AdminActivationService,
      {} as AdminAuthCookieService,
      policy,
    );
    const res = response();

    await expect(
      controller.start(
        { adminPublicId, activationGrant: rawGrant },
        request(),
        res.value,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
  });
});
