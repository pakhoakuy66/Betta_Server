import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, jest } from '@jest/globals';
import { type AdminPolicy } from '../config/admin-policy.config';
import {
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  ADMIN_ACCESS_TOKEN_AUDIENCE,
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_ACCESS_TOKEN_USE,
  ADMIN_JWT_ALGORITHM,
} from '../constants/admin-auth-token.constants';
import { AdminAccessTokenService } from './admin-access-token.service';

const ADMIN_ID = 'adm_23456789ABCD';
const SESSION_ID = `ases_${'a'.repeat(36)}`;
const ACCESS_KEY = Buffer.alloc(32, 11);
const ACCESS_KEY_ID = 'dev-admin-access-v1';

const createService = () => {
  const jwtService = new JwtService();
  const currentKey = jest.fn<(purpose: unknown) => { id: string; key: Buffer }>(
    () => ({ id: ACCESS_KEY_ID, key: ACCESS_KEY }),
  );
  const adminSecrets = {
    current: currentKey,
  } as unknown as AdminSecrets;
  const adminPolicy = {
    session: { accessTokenTtlSeconds: 900 },
  } as AdminPolicy;

  return {
    jwtService,
    adminSecrets,
    currentKey,
    service: new AdminAccessTokenService(jwtService, adminSecrets, adminPolicy),
  };
};

const validInput = {
  adminPublicId: ADMIN_ID,
  sessionPublicId: SESSION_ID,
  credentialVersion: 2,
  authzVersion: 3,
  permissionVersion: 4,
};

describe('AdminAccessTokenService', () => {
  it('issues the minimal Admin-only access claim contract', async () => {
    const { jwtService, currentKey, service } = createService();
    const token = await service.issue(validInput);

    const complete = jwtService.decode<{
      header: Record<string, unknown>;
      payload: Record<string, unknown>;
    }>(token, { complete: true });

    expect(complete.header).toEqual({
      alg: ADMIN_JWT_ALGORITHM,
      typ: 'JWT',
      kid: ACCESS_KEY_ID,
    });
    expect(complete.payload).toMatchObject({
      tokenUse: ADMIN_ACCESS_TOKEN_USE,
      sub: ADMIN_ID,
      sid: SESSION_ID,
      credentialVersion: 2,
      authzVersion: 3,
      permissionVersion: 4,
      iss: ADMIN_ACCESS_TOKEN_ISSUER,
      aud: ADMIN_ACCESS_TOKEN_AUDIENCE,
    });
    expect(complete.payload).not.toHaveProperty('_id');
    expect(complete.payload).not.toHaveProperty('role');
    expect(complete.payload).not.toHaveProperty('permissions');
    expect(complete.payload).not.toHaveProperty('email');
    expect(complete.payload.exp).toBe(Number(complete.payload.iat) + 900);
    expect(currentKey).toHaveBeenCalledWith(
      AdminSecretPurpose.ACCESS_TOKEN_SIGNING,
    );
  });

  it.each([
    [{ ...validInput, adminPublicId: 'invalid' }],
    [{ ...validInput, sessionPublicId: 'ses_user' }],
    [{ ...validInput, credentialVersion: -1 }],
    [{ ...validInput, authzVersion: 1.5 }],
    [{ ...validInput, permissionVersion: Number.NaN }],
  ])(
    'rejects invalid internal issue input before reading a key',
    async (input) => {
      const { currentKey, service } = createService();

      await expect(service.issue(input)).rejects.toBeInstanceOf(TypeError);
      expect(currentKey).not.toHaveBeenCalled();
    },
  );
});
