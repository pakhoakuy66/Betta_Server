import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from '@jest/globals';
import {
  ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ALGORITHM,
  AUTH_JWT_ISSUER,
} from '../../auth/constants/auth-token.constants';
import { type AdminPolicy } from '../config/admin-policy.config';
import {
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  ADMIN_ACCESS_TOKEN_AUDIENCE,
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_JWT_ALGORITHM,
} from '../constants/admin-auth-token.constants';
import { AdminAccessTokenService } from '../services/admin-access-token.service';
import { resolveAdminAccessTokenVerificationKey } from './admin-jwt.strategy';

const ADMIN_KEY = Buffer.alloc(32, 21);
const USER_KEY = Buffer.alloc(32, 22);
const KEY_ID = 'admin-access-v1';
const jwtService = new JwtService();

const adminSecrets = {
  current: () => ({ id: KEY_ID, key: ADMIN_KEY }),
  resolve: (purpose: unknown, keyId: unknown) => {
    if (
      purpose !== AdminSecretPurpose.ACCESS_TOKEN_SIGNING ||
      keyId !== KEY_ID
    ) {
      throw new Error('unknown key');
    }

    return { id: KEY_ID, key: ADMIN_KEY };
  },
} as unknown as AdminSecrets;

const adminPolicy = {
  session: { accessTokenTtlSeconds: 900 },
} as AdminPolicy;

describe('Admin/User JWT namespace boundary', () => {
  it('accepts a valid Admin token with the selected Admin key', async () => {
    const service = new AdminAccessTokenService(
      jwtService,
      adminSecrets,
      adminPolicy,
    );
    const token = await service.issue({
      adminPublicId: 'adm_23456789ABCD',
      sessionPublicId: `ases_${'a'.repeat(36)}`,
      credentialVersion: 0,
      authzVersion: 0,
      permissionVersion: 1,
    });

    const verificationKey = resolveAdminAccessTokenVerificationKey(
      token,
      adminSecrets,
    );

    expect(() => {
      jwtService.verify(token, {
        secret: verificationKey,
        algorithms: [ADMIN_JWT_ALGORITHM],
        issuer: ADMIN_ACCESS_TOKEN_ISSUER,
        audience: ADMIN_ACCESS_TOKEN_AUDIENCE,
      });
    }).not.toThrow();
  });

  it('rejects a User access token at the Admin boundary', () => {
    const userToken = jwtService.sign(
      {
        tokenUse: 'access',
        sid: `ses_${'u'.repeat(36)}`,
      },
      {
        secret: USER_KEY,
        algorithm: AUTH_JWT_ALGORITHM,
        keyid: KEY_ID,
        issuer: AUTH_JWT_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        subject: '6a3924c4f5a540da96575f6a',
        expiresIn: 900,
      },
    );
    const selectedAdminKey = resolveAdminAccessTokenVerificationKey(
      userToken,
      adminSecrets,
    );

    expect(() => {
      jwtService.verify(userToken, {
        secret: selectedAdminKey,
        algorithms: [ADMIN_JWT_ALGORITHM],
        issuer: ADMIN_ACCESS_TOKEN_ISSUER,
        audience: ADMIN_ACCESS_TOKEN_AUDIENCE,
      });
    }).toThrow();
  });

  it('rejects an Admin access token at the existing User boundary', async () => {
    const service = new AdminAccessTokenService(
      jwtService,
      adminSecrets,
      adminPolicy,
    );
    const adminToken = await service.issue({
      adminPublicId: 'adm_23456789ABCD',
      sessionPublicId: `ases_${'a'.repeat(36)}`,
      credentialVersion: 0,
      authzVersion: 0,
      permissionVersion: 1,
    });

    expect(() => {
      jwtService.verify(adminToken, {
        secret: USER_KEY,
        algorithms: [AUTH_JWT_ALGORITHM],
        issuer: AUTH_JWT_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
      });
    }).toThrow();
  });

  it.each([
    ['missing kid', { alg: 'HS256', typ: 'JWT' }],
    ['wrong algorithm', { alg: 'none', typ: 'JWT', kid: KEY_ID }],
    ['unknown kid', { alg: 'HS256', typ: 'JWT', kid: 'unknown' }],
    [
      'unexpected header field',
      { alg: 'HS256', typ: 'JWT', kid: KEY_ID, jku: 'https://evil.example' },
    ],
  ])('rejects %s before claim processing', (_label, header) => {
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
      'base64url',
    );
    const token = `${encodedHeader}.e30.signature`;

    expect(() =>
      resolveAdminAccessTokenVerificationKey(token, adminSecrets),
    ).toThrow('Phiên quản trị không hợp lệ hoặc đã hết hạn');
  });
});
