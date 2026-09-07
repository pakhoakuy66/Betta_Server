import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { AdminRole } from '../admin/constants/admin-account.constants';
import { type AdminAccount } from '../admin/schemas/admin-account.schema';
import { type AdminSession } from '../admin/schemas/admin-session.schema';
import { type AdminAuditService } from '../admin/services/admin-audit.service';
import { type AdminRequestPrincipal } from '../admin/types/admin-authenticated-request';
import { SponsoredTransition as Action } from './sponsored-post.constants';
import { type SponsoredPost } from './sponsored-post.schema';
import { SponsoredPostWriterService } from './sponsored-post-writer.service';

describe('SADM-SPON-01 writer input boundary', () => {
  const transaction = jest.fn();
  const writer = new SponsoredPostWriterService(
    { transaction } as unknown as Connection,
    {} as Model<SponsoredPost>,
    {} as Model<AdminAccount>,
    {} as Model<AdminSession>,
    {} as AdminAuditService,
    () => new Date(),
  );
  const actor: AdminRequestPrincipal = {
    adminAccountId: '1234567890abcdef12345678',
    publicId: 'adm_23456789ABCD',
    id: 'adm_23456789ABCD',
    username: 'fixture',
    displayName: 'Fixture',
    role: AdminRole.SUPER_ADMIN,
    sessionId: 'ases_23456789ABCDEFGH',
    credentialVersion: 0,
    authzVersion: 0,
    permissionVersion: 1,
  };
  const input = {
    content: 'Fixture',
    images: [],
    destinationUrl: 'https://example.com',
    cta: 'Visit',
    startAt: new Date('2035-01-01T00:00:00Z'),
    endAt: new Date('2035-01-03T00:00:00Z'),
  };
  const context = { reasonCode: 'campaign_review' };
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries both the account and session owner using BSON ObjectId', async () => {
    const dbSession = {} as ClientSession;
    const accountId = new Types.ObjectId(actor.adminAccountId);
    const clock = new Date();
    type ExistsQuery = (filter: Record<string, unknown>) => {
      session: (session: ClientSession) => Promise<{ _id: Types.ObjectId }>;
    };
    const accountExists = jest.fn<ExistsQuery>(() => ({
      session: jest.fn(() => Promise.resolve({ _id: accountId })),
    }));
    const sessionExists = jest.fn<ExistsQuery>(() => ({
      session: jest.fn(() => Promise.resolve({ _id: new Types.ObjectId() })),
    }));
    const postQuery = {
      select: () => postQuery,
      session: () => postQuery,
      exec: () => Promise.resolve(null),
    };
    const checkingWriter = new SponsoredPostWriterService(
      {
        transaction: async (
          work: (session: ClientSession) => Promise<unknown>,
        ) => work(dbSession),
      } as unknown as Connection,
      { findOne: () => postQuery } as unknown as Model<SponsoredPost>,
      { exists: accountExists } as unknown as Model<AdminAccount>,
      { exists: sessionExists } as unknown as Model<AdminSession>,
      {} as AdminAuditService,
      () => clock,
    );

    // Successful authentication reaches the target lookup (the target is absent).
    await expect(
      checkingWriter.transition(
        actor,
        'spn_23456789ABCDEFGH',
        0,
        Action.DELETE,
        context,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(accountExists).toHaveBeenCalledWith(
      expect.objectContaining({ _id: accountId }),
    );
    expect(sessionExists).toHaveBeenCalledWith({
      adminAccountId: accountId,
      adminPublicId: actor.publicId,
      publicId: actor.sessionId,
      revokedAt: null,
      expiresAt: { $gt: clock },
    });
    expect(accountExists).toHaveBeenCalledTimes(1);
    expect(sessionExists).toHaveBeenCalledTimes(1);
  });

  it('rejects ordinary Admin before any database write', async () => {
    await expect(
      writer.createDraft({ ...actor, role: AdminRole.ADMIN }, input, context),
    ).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('does not accept anonymous input as a privileged principal', async () => {
    await expect(
      writer.createDraft(null as never, input, context),
    ).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects unsafe creation and audit context before any database write', async () => {
    await expect(
      writer.createDraft(
        actor,
        { ...input, status: 'active' } as never,
        context,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      writer.createDraft(actor, input, { reasonCode: 'https://example.com' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([-1, 0.5, NaN, 100000])(
    'rejects invalid/exhausted version %s',
    async (version) => {
      await expect(
        writer.transition(
          actor,
          'spn_23456789ABCDEFGH',
          version,
          Action.DELETE,
          context,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it('does not allow humans to impersonate expiry workers', async () => {
    await expect(
      writer.transition(
        actor,
        'spn_23456789ABCDEFGH',
        0,
        Action.EXPIRE,
        context,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('does not allow worker API to delete or restore campaigns', async () => {
    await expect(
      writer.transitionFromWorker(
        'spn_23456789ABCDEFGH',
        0,
        Action.DELETE as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
