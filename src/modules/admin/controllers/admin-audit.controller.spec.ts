import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, jest } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import {
  ADMIN_AUDIT_TIMELINE_TARGET_PUBLIC_ID,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminAuditService } from '../services/admin-audit.service';
import { type AdminAuthenticatedRequest } from '../types/admin-authenticated-request';
import { AdminAuditController } from './admin-audit.controller';

const authenticatedRequest = {
  user: {
    adminAccountId: '6a3924c4f5a540da96575f6a',
    id: 'adm_23456789ABCD',
    publicId: 'adm_23456789ABCD',
    username: 'owner',
    displayName: 'Owner',
    role: AdminRole.SUPER_ADMIN,
    sessionId: 'ases_23456789ABCDEFGH',
    credentialVersion: 1,
    authzVersion: 1,
    permissionVersion: 2,
  },
} as AdminAuthenticatedRequest;

describe('AdminAuditController', () => {
  it('exposes only the approved GET query boundary', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminAuditController)).toBe(
      'super-admin/audit-logs',
    );
    expect(Object.getOwnPropertyNames(AdminAuditController.prototype)).toEqual([
      'constructor',
      'list',
    ]);
  });

  it('requires Admin JWT and audit_logs.view permission', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAuditController)).toEqual([
      AdminJwtAuthGuard,
      AdminPermissionGuard,
    ]);
    expect(
      Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, AdminAuditController),
    ).toEqual([AdminPermission.AUDIT_LOGS_VIEW]);
  });

  it('maps validated DTO values without accepting arbitrary filters', async () => {
    const list = jest.fn<AdminAuditService['list']>(() =>
      Promise.resolve({
        items: [],
        pagination: { page: 2, limit: 20, hasMore: false },
      }),
    );
    const record = jest.fn<AdminAuditService['record']>(() =>
      Promise.resolve(`aaud_${'2'.repeat(16)}`),
    );
    const controller = new AdminAuditController({
      list,
      record,
    } as unknown as AdminAuditService);

    await controller.list(
      {
        page: 2,
        limit: 20,
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-04T00:00:00.000Z',
      },
      authenticatedRequest,
    );

    expect(list).toHaveBeenCalledWith({
      page: 2,
      limit: 20,
      actorPublicId: undefined,
      action: undefined,
      targetType: undefined,
      targetPublicId: undefined,
      outcome: undefined,
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-04T00:00:00.000Z'),
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      action: AdminAuditAction.AUDIT_LOG_ACCESSED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: {
        type: AdminAuditActorType.ADMIN_ACCOUNT,
        publicId: authenticatedRequest.user.publicId,
        username: authenticatedRequest.user.username,
        displayName: authenticatedRequest.user.displayName,
        role: AdminRole.SUPER_ADMIN,
        permission: AdminPermission.AUDIT_LOGS_VIEW,
        permissionVersion: authenticatedRequest.user.permissionVersion,
      },
      target: {
        type: AdminAuditTargetType.AUDIT_LOG,
        publicId: ADMIN_AUDIT_TIMELINE_TARGET_PUBLIC_ID,
      },
      reasonCode: 'audit_timeline_viewed',
      source: AdminAuditSource.HTTP,
    });
  });

  it('does not return successful query data when access audit write fails', async () => {
    const listResult = {
      items: [],
      pagination: { page: 1, limit: 20, hasMore: false },
    } as const;
    const failure = new Error('audit unavailable');
    const controller = new AdminAuditController({
      list: jest.fn<AdminAuditService['list']>(() =>
        Promise.resolve(listResult),
      ),
      record: jest.fn<AdminAuditService['record']>(() =>
        Promise.reject(failure),
      ),
    } as unknown as AdminAuditService);

    await expect(
      controller.list({ page: 1, limit: 20 }, authenticatedRequest),
    ).rejects.toBe(failure);
  });
});
