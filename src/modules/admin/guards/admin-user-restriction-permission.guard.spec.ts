import {
  BadRequestException,
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { UserRestrictionType } from '../../users/constants/user-moderation.constants';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminUserRestrictionOperation } from '../constants/admin-user-restriction.constants';
import type { AdminRequestPrincipal } from '../types/admin-authenticated-request';
import { AdminUserRestrictionPermissionGuard } from './admin-user-restriction-permission.guard';

const principal = (role: AdminRole): AdminRequestPrincipal => ({
  adminAccountId: '6a3924c4f5a540da96575f6a',
  id: 'adm_23456789ABCD',
  publicId: 'adm_23456789ABCD',
  username: 'moderation.admin',
  displayName: 'Moderation Admin',
  role,
  sessionId: 'ases_23456789ABCDEFGHJKLMNPQR',
  credentialVersion: 1,
  authzVersion: 1,
  permissionVersion: 1,
});

const context = (
  user: unknown,
  operation: unknown,
  restrictionType: unknown,
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user, body: { operation, restrictionType } }),
    }),
  }) as unknown as ExecutionContext;

describe('AdminUserRestrictionPermissionGuard', () => {
  const guard = new AdminUserRestrictionPermissionGuard();

  it.each([
    AdminUserRestrictionOperation.APPLY,
    AdminUserRestrictionOperation.REMOVE,
  ])('allows Admin to apply or remove a temporary suspension', (operation) => {
    expect(
      guard.canActivate(
        context(
          principal(AdminRole.ADMIN),
          operation,
          UserRestrictionType.TEMPORARY_SUSPENSION,
        ),
      ),
    ).toBe(true);
  });

  it.each([
    AdminUserRestrictionOperation.APPLY,
    AdminUserRestrictionOperation.REMOVE,
  ])('allows only SuperAdmin to apply or remove a ban', (operation) => {
    expect(() =>
      guard.canActivate(
        context(
          principal(AdminRole.ADMIN),
          operation,
          UserRestrictionType.INDEFINITE_BAN,
        ),
      ),
    ).toThrow(ForbiddenException);

    expect(
      guard.canActivate(
        context(
          principal(AdminRole.SUPER_ADMIN),
          operation,
          UserRestrictionType.INDEFINITE_BAN,
        ),
      ),
    ).toBe(true);
  });

  it('rejects an invalid operation/type combination', () => {
    expect(() =>
      guard.canActivate(
        context(
          principal(AdminRole.SUPER_ADMIN),
          'INVALID',
          UserRestrictionType.INDEFINITE_BAN,
        ),
      ),
    ).toThrow(BadRequestException);
  });

  it('fails closed for a missing principal', () => {
    expect(() =>
      guard.canActivate(
        context(
          undefined,
          AdminUserRestrictionOperation.APPLY,
          UserRestrictionType.TEMPORARY_SUSPENSION,
        ),
      ),
    ).toThrow(UnauthorizedException);
  });
});
