import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { type AdminPolicy } from '../config/admin-policy.config';
import { type AdminSecrets } from '../config/admin-secrets.config';
import { AdminRole } from '../constants/admin-account.constants';
import {
  ADMIN_ACCESS_TOKEN_AUDIENCE,
  ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_ACCESS_TOKEN_USE,
} from '../constants/admin-auth-token.constants';
import { type ResolveAdminAuthorizationInput } from '../interfaces/admin-authorization-state.interface';
import { AdminAuthorizationStateService } from '../services/admin-authorization-state.service';
import { type AdminRequestPrincipal } from '../types/admin-authenticated-request';
import { AdminJwtStrategy } from './admin-jwt.strategy';

const ADMIN_OBJECT_ID = '6a3924c4f5a540da96575f6a';
const ADMIN_ID = 'adm_23456789ABCD';
const SESSION_ID = `ases_${'a'.repeat(36)}`;

const adminSecrets = {
  resolve: jest.fn(),
} as unknown as AdminSecrets;

const adminPolicy = {
  session: { accessTokenTtlSeconds: 900 },
} as AdminPolicy;

const validPayload = {
  tokenUse: ADMIN_ACCESS_TOKEN_USE,
  sub: ADMIN_ID,
  sid: SESSION_ID,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
  iss: ADMIN_ACCESS_TOKEN_ISSUER,
  aud: ADMIN_ACCESS_TOKEN_AUDIENCE,
  iat: 1_000,
  exp: 1_900,
};

const principal = Object.freeze({
  adminAccountId: ADMIN_OBJECT_ID,
  id: ADMIN_ID,
  publicId: ADMIN_ID,
  username: 'admin.qa',
  displayName: 'Admin QA',
  role: AdminRole.ADMIN,
  sessionId: SESSION_ID,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
});

const createContext = () => {
  const authorizationState = {
    resolvePrincipal: jest.fn(
      (
        input: ResolveAdminAuthorizationInput,
      ): Promise<AdminRequestPrincipal | null> => {
        void input;
        return Promise.resolve(principal);
      },
    ),
  };
  const strategy = new AdminJwtStrategy(
    adminSecrets,
    adminPolicy,
    authorizationState as unknown as AdminAuthorizationStateService,
  );

  return { strategy, authorizationState };
};

describe('AdminJwtStrategy', () => {
  it.each([
    [{ ...validPayload, tokenUse: 'access' }],
    [{ ...validPayload, sub: 'usr_23456789ABCD' }],
    [{ ...validPayload, sid: `ses_${'a'.repeat(36)}` }],
    [{ ...validPayload, permissionVersion: -1 }],
    [{ ...validPayload, exp: 1_901 }],
    [{ ...validPayload, role: AdminRole.SUPER_ADMIN }],
    [{ ...validPayload, permissions: ['admins.create'] }],
    [{ ...validPayload, _id: ADMIN_OBJECT_ID }],
  ])(
    'rejects an invalid or expanded claim contract before lookup',
    async (payload) => {
      const { strategy, authorizationState } = createContext();

      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(authorizationState.resolvePrincipal).not.toHaveBeenCalled();
    },
  );

  it('accepts iat at the configured future clock-skew boundary', async () => {
    const iat =
      Math.floor(Date.now() / 1000) + ADMIN_ACCESS_TOKEN_CLOCK_SKEW_SECONDS;
    const { strategy } = createContext();

    await expect(
      strategy.validate({ ...validPayload, iat, exp: iat + 900 }),
    ).resolves.toBe(principal);
  });

  it('delegates the exact token state and returns the immutable principal', async () => {
    const { strategy, authorizationState } = createContext();

    await expect(strategy.validate(validPayload)).resolves.toBe(principal);
    expect(authorizationState.resolvePrincipal).toHaveBeenCalledWith({
      adminPublicId: ADMIN_ID,
      sessionPublicId: SESSION_ID,
      credentialVersion: 2,
      authzVersion: 3,
      permissionVersion: 4,
    });
  });

  it('normalizes denied shared state to the generic 401 contract', async () => {
    const { strategy, authorizationState } = createContext();
    authorizationState.resolvePrincipal.mockResolvedValue(null);

    await expect(strategy.validate(validPayload)).rejects.toMatchObject({
      message: 'Phiên quản trị không hợp lệ hoặc đã hết hạn',
    });
  });

  it('preserves sanitized shared-store unavailability as 503', async () => {
    const { strategy, authorizationState } = createContext();
    const error = new ServiceUnavailableException(
      'Dịch vụ xác thực quản trị tạm thời không khả dụng',
    );
    authorizationState.resolvePrincipal.mockRejectedValue(error);

    await expect(strategy.validate(validPayload)).rejects.toBe(error);
  });

  it('does not disguise programming errors as authentication failures', async () => {
    const { strategy, authorizationState } = createContext();
    const error = new TypeError('authorization contract broken');
    authorizationState.resolvePrincipal.mockRejectedValue(error);

    await expect(strategy.validate(validPayload)).rejects.toBe(error);
  });
});
