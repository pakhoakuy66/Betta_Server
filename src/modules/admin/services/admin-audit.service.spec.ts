import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { type ClientSession, type Model } from 'mongoose';
import { createAdminPolicy } from '../config/admin-policy.config';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import {
  ADMIN_AUDIT_RETENTION_DAYS,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { type RecordAdminAuditInput } from '../interfaces/admin-audit.interface';
import { AdminAuditEvent } from '../schemas/admin-audit-event.schema';
import { AdminAuditService } from './admin-audit.service';

const NOW = new Date('2026-08-04T00:00:00.000Z');
const AUDIT_ID = `aaud_${'2'.repeat(16)}`;
const activeTransactionSession = (): ClientSession =>
  ({ inTransaction: () => true }) as ClientSession;

type InsertManyFunction = (
  documents: Array<Record<string, unknown>>,
  options: Readonly<{ ordered: boolean; session?: ClientSession }>,
) => Promise<Array<{ publicId: string }>>;

type QueryChain<T> = {
  sort: jest.Mock<(sort: unknown) => QueryChain<T>>;
  skip: jest.Mock<(skip: number) => QueryChain<T>>;
  limit: jest.Mock<(limit: number) => QueryChain<T>>;
  select: jest.Mock<(projection: string) => QueryChain<T>>;
  lean: jest.Mock<() => QueryChain<T>>;
  exec: jest.Mock<() => Promise<T>>;
};

type FindFunction = (filter: unknown) => QueryChain<unknown[]>;

const queryChain = <T>(result: T): QueryChain<T> => {
  const chain = {
    sort: jest.fn<(sort: unknown) => QueryChain<T>>(),
    skip: jest.fn<(skip: number) => QueryChain<T>>(),
    limit: jest.fn<(limit: number) => QueryChain<T>>(),
    select: jest.fn<(projection: string) => QueryChain<T>>(),
    lean: jest.fn<() => QueryChain<T>>(),
    exec: jest.fn<() => Promise<T>>(() => Promise.resolve(result)),
  };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
};

const createContext = () => {
  const insertMany = jest.fn<InsertManyFunction>(() =>
    Promise.resolve([{ publicId: AUDIT_ID }]),
  );
  const find = jest.fn<FindFunction>();
  const model = { insertMany, find } as unknown as Model<AdminAuditEvent>;
  const policy = createAdminPolicy({ get: () => undefined });
  return {
    service: new AdminAuditService(model, policy),
    insertMany,
    find,
    policy,
  };
};

const validInput = (
  overrides: Partial<RecordAdminAuditInput> = {},
): RecordAdminAuditInput => ({
  action: AdminAuditAction.ADMIN_LOCKED,
  outcome: AdminAuditOutcome.SUCCEEDED,
  actor: {
    type: AdminAuditActorType.ADMIN_ACCOUNT,
    publicId: 'adm_23456789ABCD',
    username: 'owner',
    displayName: 'Owner',
    role: AdminRole.SUPER_ADMIN,
    permission: AdminPermission.ADMINS_LOCK,
    permissionVersion: 1,
  },
  target: {
    type: AdminAuditTargetType.ADMIN_ACCOUNT,
    publicId: 'adm_23456789ABCE',
  },
  reasonCode: 'security_review',
  metadata: {
    beforeVersion: 1,
    afterVersion: 2,
    beforeState: 'ACTIVE',
    afterState: 'LOCKED',
    affectedSessionCount: 1,
  },
  correlationId: 'req_23456789ABCDEFGH',
  source: AdminAuditSource.HTTP,
  mongoSession: activeTransactionSession(),
  ...overrides,
});

describe('AdminAuditService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('writes an allowlisted record with fixed 365-day retention', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { service, insertMany } = createContext();

    await expect(service.record(validInput())).resolves.toBe(AUDIT_ID);

    const documents = insertMany.mock.calls[0]?.[0];
    if (!documents) throw new Error('Thiếu audit insert fixture');
    const document = documents[0];
    expect(document).toEqual(
      expect.objectContaining({
        action: AdminAuditAction.ADMIN_LOCKED,
        reasonCode: 'security_review',
        expiresAt: new Date(
          NOW.getTime() + ADMIN_AUDIT_RETENTION_DAYS * 86_400_000,
        ),
      }),
    );
    expect(document).not.toHaveProperty('_id');
    expect(document).not.toHaveProperty('password');
  });

  it('passes the caller transaction to insertMany', async () => {
    const { service, insertMany } = createContext();
    const mongoSession = activeTransactionSession();
    await service.record(validInput({ mongoSession }));
    expect(insertMany).toHaveBeenCalledWith([expect.any(Object)], {
      ordered: true,
      session: mongoSession,
    });
  });

  it('rejects mutation audit when session has no active transaction', async () => {
    const { service, insertMany } = createContext();
    await expect(
      service.record(
        validInput({
          mongoSession: {
            inTransaction: () => false,
          } as ClientSession,
        }),
      ),
    ).rejects.toThrow('transaction đang active');
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('rejects mutation audit when caller omits the session', async () => {
    const { service, insertMany } = createContext();
    await expect(
      service.record(validInput({ mongoSession: undefined })),
    ).rejects.toThrow('transaction đang active');
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('allows audit timeline access logging without a transaction', async () => {
    const { service, insertMany } = createContext();
    await expect(
      service.record(
        validInput({
          action: AdminAuditAction.AUDIT_LOG_ACCESSED,
          target: {
            type: AdminAuditTargetType.AUDIT_LOG,
            publicId: AUDIT_ID,
          },
          mongoSession: undefined,
        }),
      ),
    ).resolves.toBe(AUDIT_ID);
    expect(insertMany).toHaveBeenCalledWith([expect.any(Object)], {
      ordered: true,
      session: undefined,
    });
  });

  it('allows self-session audit without inventing an RBAC permission', async () => {
    const { service, insertMany } = createContext();
    await expect(
      service.record(
        validInput({
          action: AdminAuditAction.SESSION_REVOKED,
          actor: {
            type: AdminAuditActorType.ADMIN_ACCOUNT,
            publicId: 'adm_23456789ABCD',
            username: 'owner',
            displayName: 'Owner',
            role: AdminRole.SUPER_ADMIN,
            permissionVersion: 1,
          },
          target: {
            type: AdminAuditTargetType.ADMIN_SESSION,
            publicId: 'ases_23456789ABCDEFGH',
          },
        }),
      ),
    ).resolves.toBe(AUDIT_ID);
    const stored = insertMany.mock.calls[0]?.[0][0];
    expect(stored?.actor).not.toHaveProperty('permission');
  });

  it('still requires permission for RBAC-gated business actions', async () => {
    const { service } = createContext();
    await expect(
      service.record(
        validInput({
          actor: {
            type: AdminAuditActorType.ADMIN_ACCOUNT,
            publicId: 'adm_23456789ABCD',
            username: 'owner',
            displayName: 'Owner',
            role: AdminRole.SUPER_ADMIN,
            permissionVersion: 1,
          },
        }),
      ),
    ).rejects.toThrow('actor AdminAccount không hợp lệ');
  });

  it('rejects mismatched action/target and malformed Admin actor', async () => {
    const { service } = createContext();
    await expect(
      service.record(
        validInput({
          target: {
            type: AdminAuditTargetType.USER,
            publicId: 'usr_23456789ABCD',
          },
        }),
      ),
    ).rejects.toThrow('target không khớp action');

    await expect(
      service.record(
        validInput({
          actor: { type: AdminAuditActorType.ADMIN_ACCOUNT, displayName: 'x' },
        }),
      ),
    ).rejects.toThrow('actor AdminAccount không hợp lệ');
  });

  it('stores assignment ownership changes in allowlisted metadata', async () => {
    const { service, insertMany } = createContext();
    await service.record(
      validInput({
        action: AdminAuditAction.REPORT_REASSIGNED,
        actor: {
          type: AdminAuditActorType.ADMIN_ACCOUNT,
          publicId: 'adm_23456789ABCD',
          username: 'owner',
          displayName: 'Owner',
          role: AdminRole.SUPER_ADMIN,
          permission: AdminPermission.REPORTS_REVIEW,
          permissionVersion: 1,
        },
        target: {
          type: AdminAuditTargetType.REPORT,
          publicId: 'rpt_23456789ABCDEFGH',
        },
        metadata: {
          beforeVersion: 1,
          afterVersion: 2,
          beforeState: 'reviewing',
          afterState: 'reviewing',
          beforeAssigneePublicId: 'adm_23456789ABCE',
          afterAssigneePublicId: 'adm_23456789ABCF',
        },
      }),
    );

    expect(insertMany.mock.calls[0]?.[0][0]?.metadata).toEqual(
      expect.objectContaining({
        beforeAssigneePublicId: 'adm_23456789ABCE',
        afterAssigneePublicId: 'adm_23456789ABCF',
      }),
    );
  });
  it('rejects unknown metadata and secret-bearing reason notes', async () => {
    const { service } = createContext();
    await expect(
      service.record(
        validInput({
          metadata: { token: 'secret' } as never,
        }),
      ),
    ).rejects.toThrow('metadata không hỗ trợ: token');
    await expect(
      service.record(validInput({ reasonNote: 'Bearer token abc' })),
    ).rejects.toThrow('reasonNote chứa dữ liệu bị cấm');
  });

  it('rejects an incomplete lifecycle diff before persistence', async () => {
    const { service, insertMany } = createContext();
    await expect(
      service.record(
        validInput({
          metadata: {
            beforeVersion: 1,
            afterVersion: 2,
            beforeState: 'ACTIVE',
            afterState: 'LOCKED',
          },
        }),
      ),
    ).rejects.toThrow(
      'Admin lifecycle audit metadata thieu truong bat buoc: affectedSessionCount',
    );
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('requires a version-only safe diff for reserved permission updates', async () => {
    const { service, insertMany } = createContext();
    await expect(
      service.record(
        validInput({
          action: AdminAuditAction.ADMIN_PERMISSIONS_UPDATED,
          actor: {
            ...validInput().actor,
            permission: AdminPermission.ADMINS_PERMISSIONS_UPDATE,
          },
          metadata: { beforeVersion: 1 },
        }),
      ),
    ).rejects.toThrow(
      'Admin lifecycle audit metadata thieu truong bat buoc: afterVersion',
    );
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('maps non-transaction Mongo outage to 503 without logging raw error', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, insertMany } = createContext();
    insertMany.mockRejectedValue(
      Object.assign(new Error('mongodb://user:password@host'), {
        name: 'MongoNetworkError',
      }),
    );
    await expect(
      service.record(
        validInput({
          action: AdminAuditAction.AUDIT_LOG_ACCESSED,
          target: {
            type: AdminAuditTargetType.AUDIT_LOG,
            publicId: AUDIT_ID,
          },
          mongoSession: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(log.mock.calls.flat().join(' ')).not.toContain('mongodb://');
  });

  it('rethrows persistence failures inside a transaction for rollback', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, insertMany } = createContext();
    const error = Object.assign(new Error('write conflict'), { code: 112 });
    insertMany.mockRejectedValue(error);
    await expect(
      service.record(validInput({ mongoSession: activeTransactionSession() })),
    ).rejects.toBe(error);
  });

  it('queries only unexpired records with stable pagination and public mapping', async () => {
    const { service, find } = createContext();
    const records = [0, 1, 2].map((offset) => ({
      publicId: `aaud_${String(offset + 2).repeat(16)}`,
      schemaVersion: 1,
      action: AdminAuditAction.ADMIN_LOCKED,
      outcome: AdminAuditOutcome.SUCCEEDED,
      actor: validInput().actor,
      target: validInput().target,
      reasonCode: 'security_review',
      source: AdminAuditSource.HTTP,
      occurredAt: new Date(NOW.getTime() - offset * 1000),
    }));
    const chain = queryChain(records);
    find.mockReturnValue(chain as QueryChain<unknown[]>);

    const result = await service.list({ page: 1, limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.items[0]).not.toHaveProperty('_id');
    expect(result.items[0]?.occurredAt).toBe(NOW.toISOString());
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: { $gt: expect.any(Date) } }),
    );
    expect(chain.sort).toHaveBeenCalledWith({ occurredAt: -1, publicId: 1 });
    expect(chain.limit).toHaveBeenCalledWith(3);
    expect(chain.select).toHaveBeenCalledWith('-_id -expiresAt');
  });

  it('maps nested public fields explicitly and drops rogue database fields', async () => {
    const { service, find } = createContext();
    const chain = queryChain([
      {
        publicId: AUDIT_ID,
        schemaVersion: 1,
        action: AdminAuditAction.ADMIN_LOCKED,
        outcome: AdminAuditOutcome.SUCCEEDED,
        actor: {
          ...validInput().actor,
          _id: 'internal-object-id',
          password: 'must-not-leak',
        },
        target: {
          ...validInput().target,
          internalId: 'must-not-leak',
        },
        reasonCode: 'security_review',
        metadata: {
          beforeVersion: 0,
          afterVersion: 1,
          token: 'must-not-leak',
          unknownField: 'must-not-leak',
        },
        source: AdminAuditSource.HTTP,
        occurredAt: NOW,
      },
    ]);
    find.mockReturnValue(chain as QueryChain<unknown[]>);

    const result = await service.list({ page: 1, limit: 20 });
    const serialized = JSON.stringify(result.items[0]);

    expect(result.items[0]?.actor).toEqual(validInput().actor);
    expect(result.items[0]?.target).toEqual(validInput().target);
    expect(result.items[0]?.metadata).toEqual({
      beforeVersion: 0,
      afterVersion: 1,
    });
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('internal-object-id');
    expect(serialized).not.toContain('unknownField');
  });

  it('rejects invalid pagination and reversed time range before querying', async () => {
    const { service, find } = createContext();
    await expect(service.list({ page: 0, limit: 20 })).rejects.toThrow(
      'pagination không hợp lệ',
    );
    await expect(
      service.list({
        page: 1,
        limit: 20,
        from: new Date('2026-08-05T00:00:00Z'),
        to: new Date('2026-08-04T00:00:00Z'),
      }),
    ).rejects.toThrow('time range không hợp lệ');
    expect(find).not.toHaveBeenCalled();
  });
});
