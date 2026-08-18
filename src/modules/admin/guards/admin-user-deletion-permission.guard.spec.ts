import {
  BadRequestException,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminUserDeletionOperation } from '../constants/admin-user-deletion.constants';
import type { AdminRequestPrincipal } from '../types/admin-authenticated-request';
import { AdminUserDeletionPermissionGuard } from './admin-user-deletion-permission.guard';

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

const context = (user: unknown, operation: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user, body: { operation } }),
    }),
  }) as unknown as ExecutionContext;

describe('AdminUserDeletionPermissionGuard', () => {
  const guard = new AdminUserDeletionPermissionGuard();

  it.each([AdminRole.ADMIN, AdminRole.SUPER_ADMIN])(
    'allows %s to soft-delete and restore User',
    (role) => {
      expect(
        guard.canActivate(
          context(principal(role), AdminUserDeletionOperation.DELETE),
        ),
      ).toBe(true);
      expect(
        guard.canActivate(
          context(principal(role), AdminUserDeletionOperation.RESTORE),
        ),
      ).toBe(true);
    },
  );

  it('rejects hard-delete and missing principals', () => {
    expect(() =>
      guard.canActivate(context(principal(AdminRole.SUPER_ADMIN), 'HARD')),
    ).toThrow(BadRequestException);
    expect(() =>
      guard.canActivate(context(undefined, AdminUserDeletionOperation.DELETE)),
    ).toThrow(UnauthorizedException);
  });
});
