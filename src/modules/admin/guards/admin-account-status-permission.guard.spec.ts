import {
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import {
  AdminAccountStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { type AdminRequestPrincipal } from '../types/admin-authenticated-request';
import { AdminAccountStatusPermissionGuard } from './admin-account-status-permission.guard';

const principal = (role: AdminRole): AdminRequestPrincipal => ({
  adminAccountId: '6a3924c4f5a540da96575f6a',
  id: 'adm_23456789ABCD',
  publicId: 'adm_23456789ABCD',
  username: 'admin.qa',
  displayName: 'Admin QA',
  role,
  sessionId: 'ases_23456789ABCDEFGHJKLMNPQR',
  credentialVersion: 1,
  authzVersion: 1,
  permissionVersion: 1,
});

const context = (user: unknown, status: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user, body: { status } }),
    }),
  }) as unknown as ExecutionContext;

describe('AdminAccountStatusPermissionGuard', () => {
  const guard = new AdminAccountStatusPermissionGuard();

  it.each([AdminAccountStatus.LOCKED, AdminAccountStatus.ACTIVE])(
    'allows SuperAdmin for %s',
    (status) => {
      expect(
        guard.canActivate(context(principal(AdminRole.SUPER_ADMIN), status)),
      ).toBe(true);
    },
  );

  it('denies Admin before status service access', () => {
    expect(() =>
      guard.canActivate(
        context(principal(AdminRole.ADMIN), AdminAccountStatus.LOCKED),
      ),
    ).toThrow(ForbiddenException);
  });

  it('fails closed for a missing principal', () => {
    expect(() =>
      guard.canActivate(context(undefined, AdminAccountStatus.LOCKED)),
    ).toThrow(UnauthorizedException);
  });
});
