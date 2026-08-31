import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminReauthPurpose } from '../constants/admin-reauth.constants';
import { type AdminAccessSupportContactActor } from '../interfaces/admin-access-support-contact.interface';
import { AdminAccessSupportContactService } from './admin-access-support-contact.service';

const reportPublicId = 'srep_23456789ABCDEFGH';
const rawContact = 'private.person@example.com';
const actor: AdminAccessSupportContactActor = Object.freeze({
  type: AdminAuditActorType.ADMIN_ACCOUNT,
  adminAccountId: new Types.ObjectId(),
  publicId: 'adm_23456789ABCD',
  username: 'root_admin',
  displayName: 'Root Admin',
  role: AdminRole.SUPER_ADMIN,
  permission: AdminPermission.REPORTS_CONTACT_SENSITIVE_VIEW,
  permissionVersion: 3,
  sessionPublicId: 'ases_23456789ABCDEFGHJKLMNPQR',
  credentialVersion: 2,
  authzVersion: 4,
});

const createService = (
  stored: Readonly<{
    publicId: string;
    encryptedContactEmail: string;
  }> | null = {
    publicId: reportPublicId,
    encryptedContactEmail: 'asenc.v1.enc-v1.iv.cipher.tag',
  },
) => {
  const mongoSession = { inTransaction: () => true };
  const query = {
    select: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(() => Promise.resolve(stored)),
  };
  const reports = {
    exists: jest.fn((filter: unknown) => {
      void filter;
      return Promise.resolve(stored ? { _id: new Types.ObjectId() } : null);
    }),
    findOne: jest.fn((filter: unknown) => {
      void filter;
      return query;
    }),
  };
  const connection = {
    transaction: jest.fn(
      async (work: (session: typeof mongoSession) => Promise<unknown>) =>
        work(mongoSession),
    ),
  };
  const crypto = {
    decrypt: jest.fn(
      (value: string, boundReportPublicId: string, field: string) => {
        void value;
        void boundReportPublicId;
        void field;
        return rawContact;
      },
    ),
  };
  const reauth = {
    issue: jest.fn((input: unknown) => {
      void input;
      return Promise.resolve({
        grant: 'grant',
        expiresAt: new Date('2026-08-30T10:05:00.000Z'),
      });
    }),
    consumeInTransaction: jest.fn((input: unknown) => {
      void input;
      return Promise.resolve(undefined);
    }),
  };
  const audit = {
    record: jest.fn((input: unknown) => {
      void input;
      return Promise.resolve('aaud_23456789ABCDEFGH');
    }),
  };
  const service = new AdminAccessSupportContactService(
    reports as never,
    connection as never,
    crypto as never,
    reauth as never,
    audit as never,
  );

  return { service, reports, connection, crypto, reauth, audit, mongoSession };
};

const revealInput = () => ({
  actor,
  reportPublicId,
  reauthGrant: 'raw-grant',
  reason: 'support_follow_up',
  correlationId: 'corr_mod10_reveal_0001',
  source: AdminAuditSource.HTTP,
});

describe('AdminAccessSupportContactService', () => {
  it('issues a purpose/target/session-bound re-auth grant', async () => {
    const { service, reauth } = createService();

    await service.issueReauth({
      actor,
      reportPublicId,
      password: 'StrongPassword!1',
      totpToken: '123456',
      trustedClientIp: '127.0.0.1',
      source: AdminAuditSource.HTTP,
    });

    expect(reauth.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        adminPublicId: actor.publicId,
        sessionPublicId: actor.sessionPublicId,
        purpose: AdminReauthPurpose.REPORT_CONTACT_REVEAL,
        targetPublicId: reportPublicId,
      }),
    );
  });

  it('denies non-SuperAdmin even if called outside the HTTP guard', async () => {
    const { service, reauth } = createService();
    const adminActor = {
      ...actor,
      role: AdminRole.ADMIN,
    } as AdminAccessSupportContactActor;

    await expect(
      service.issueReauth({
        actor: adminActor,
        reportPublicId,
        password: 'StrongPassword!1',
        totpToken: '123456',
        trustedClientIp: '127.0.0.1',
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reauth.issue).not.toHaveBeenCalled();
  });

  it('consumes the grant and audits only allowlisted metadata before reveal', async () => {
    const { service, reauth, audit, crypto, mongoSession } = createService();

    await expect(service.reveal(revealInput())).resolves.toEqual({
      reportPublicId,
      contactEmail: rawContact,
    });

    expect(reauth.consumeInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: AdminReauthPurpose.REPORT_CONTACT_REVEAL,
        targetPublicId: reportPublicId,
        mongoSession,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: AdminAuditOutcome.SUCCEEDED,
        target: {
          type: AdminAuditTargetType.SYSTEM_REPORT,
          publicId: reportPublicId,
        },
        reasonCode: 'support_follow_up',
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(rawContact);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'asenc.v1.enc-v1',
    );
    expect(crypto.decrypt).toHaveBeenCalledTimes(1);
  });

  it('audits a denied IDOR/purpose/expiry consume without decrypting', async () => {
    const { service, reauth, audit, crypto } = createService();
    reauth.consumeInTransaction.mockImplementationOnce(() =>
      Promise.reject(new UnauthorizedException('grant rejected')),
    );

    await expect(service.reveal(revealInput())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(crypto.decrypt).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: AdminAuditOutcome.DENIED }),
    );
  });

  it('consumes the grant, audits failure and returns generic 503 on corrupt data', async () => {
    const { service, reauth, audit, crypto } = createService();
    crypto.decrypt.mockImplementationOnce(() => {
      throw new Error(`cipher failure ${rawContact}`);
    });

    await expect(service.reveal(revealInput())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(reauth.consumeInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: AdminAuditOutcome.FAILED }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(rawContact);
  });

  it('returns a generic 404 when the report/contact is absent or purged', async () => {
    const { service, reauth } = createService(null);

    await expect(
      service.issueReauth({
        actor,
        reportPublicId,
        password: 'StrongPassword!1',
        totpToken: '123456',
        trustedClientIp: '127.0.0.1',
        source: AdminAuditSource.HTTP,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reauth.issue).not.toHaveBeenCalled();
  });
});
