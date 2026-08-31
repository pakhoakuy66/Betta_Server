import { describe, expect, it, jest } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminAuditSource } from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { ADMIN_PERMISSIONS_METADATA } from '../decorators/require-admin-permissions.decorator';
import { AdminAccessSupportContactController } from './admin-access-support-contact.controller';

const request = {
  user: {
    adminAccountId: '507f1f77bcf86cd799439011',
    id: 'adm_23456789ABCD',
    publicId: 'adm_23456789ABCD',
    username: 'root_admin',
    displayName: 'Root Admin',
    role: AdminRole.SUPER_ADMIN,
    sessionId: 'ases_23456789ABCDEFGHJKLMNPQR',
    credentialVersion: 1,
    authzVersion: 2,
    permissionVersion: 3,
  },
  ip: '127.0.0.1',
  get: jest.fn(),
};

const response = () => ({ setHeader: jest.fn() });

describe('AdminAccessSupportContactController', () => {
  it('requires reports.view and the SuperAdmin-only sensitive contact permission', () => {
    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSIONS_METADATA,
        AdminAccessSupportContactController,
      ),
    ).toEqual([
      AdminPermission.REPORTS_VIEW,
      AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW,
    ]);
  });

  it('issues route-bound re-auth and applies private response headers', async () => {
    const contacts = {
      issueReauth: jest.fn((input: unknown) => {
        void input;
        return Promise.resolve({ grant: 'grant' });
      }),
      reveal: jest.fn(),
    };
    const controller = new AdminAccessSupportContactController(
      contacts as never,
    );
    const res = response();

    await controller.issueReauth(
      { publicId: 'srep_23456789ABCDEFGH' },
      { password: 'password', totpToken: '123456' },
      request as never,
      res as never,
    );

    expect(contacts.issueReauth).toHaveBeenCalledWith(
      expect.objectContaining({
        reportPublicId: 'srep_23456789ABCDEFGH',
        source: AdminAuditSource.HTTP,
        actor: expect.objectContaining({
          role: AdminRole.SUPER_ADMIN,
          permission: AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW,
        }),
      }),
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'no-referrer',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
  });

  it('passes only the grant, reason and correlation ID to reveal service', async () => {
    const contacts = {
      issueReauth: jest.fn(),
      reveal: jest.fn((input: unknown) => {
        void input;
        return Promise.resolve({
          reportPublicId: 'srep_23456789ABCDEFGH',
          contactEmail: 'private@example.com',
        });
      }),
    };
    const controller = new AdminAccessSupportContactController(
      contacts as never,
    );

    await controller.reveal(
      { publicId: 'srep_23456789ABCDEFGH' },
      {
        reauthGrant: 'grant',
        reason: 'support_follow_up',
        correlationId: 'corr_mod10_reveal_0001',
      },
      request as never,
      response() as never,
    );

    expect(contacts.reveal).toHaveBeenCalledWith(
      expect.objectContaining({
        reportPublicId: 'srep_23456789ABCDEFGH',
        reauthGrant: 'grant',
        reason: 'support_follow_up',
        correlationId: 'corr_mod10_reveal_0001',
      }),
    );
  });
});
