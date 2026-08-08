import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';

const principal = Object.freeze({
  adminAccountId: '6a3924c4f5a540da96575f6a',
  id: 'adm_23456789ABCD',
  publicId: 'adm_23456789ABCD',
  username: 'admin.qa',
  displayName: 'Admin QA',
  role: AdminRole.ADMIN,
  sessionId: `ases_${'a'.repeat(36)}`,
  credentialVersion: 0,
  authzVersion: 0,
  permissionVersion: 1,
});

describe('AdminJwtAuthGuard', () => {
  const guard = new AdminJwtAuthGuard();

  it('returns only a valid Admin principal', () => {
    expect(guard.handleRequest(null, principal)).toBe(principal);
  });

  it.each([
    [null],
    [{ ...principal, id: 'usr_23456789ABCD' }],
    [{ ...principal, sessionId: `ses_${'a'.repeat(36)}` }],
    [{ ...principal, role: 'USER' }],
  ])('normalizes a missing or malformed principal to generic 401', (value) => {
    expect(() => guard.handleRequest(null, value)).toThrow(
      UnauthorizedException,
    );

    try {
      guard.handleRequest(null, value);
    } catch (error: unknown) {
      expect((error as UnauthorizedException).message).not.toContain(
        '6a3924c4f5a540da96575f6a',
      );
    }
  });

  it('preserves infrastructure errors for a sanitized 503 response', () => {
    const error = new ServiceUnavailableException();

    expect(() => guard.handleRequest(error, false)).toThrow(error);
  });
});
