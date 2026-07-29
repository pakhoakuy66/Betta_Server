import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';

import { USER_STATUS, User } from '../../users/schemas/user.schema';
import { GoogleOAuthAccountLinkUnavailableException } from '../exceptions/google-oauth-account-link-unavailable.exception';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
} from '../interfaces/auth-audit.interface';
import { AuthAuditService } from './auth-audit.service';
import { GoogleOAuthAccountLinkService } from './google-oauth-account-link.service';
import { GoogleOAuthContinuationGrantService } from './google-oauth-continuation-grant.service';
import { OAuthIdentityService } from './oauth-identity.service';

const NOW = new Date('2026-07-22T10:00:00.000Z');
const RAW_GRANT = 'a'.repeat(43);
const GOOGLE_SUBJECT = 'google-subject-123';

type UserResult = {
  _id: Types.ObjectId;
} | null;

type UserQueryStub = {
  lean: jest.Mock<() => UserQueryStub>;
  exec: jest.Mock<() => Promise<UserResult>>;
};

type FindOneAndUpdate = (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  options: Record<string, unknown>,
) => UserQueryStub;

const createContext = (userResult?: UserResult) => {
  const authenticatedUserId = new Types.ObjectId();

  const mongoSession = {
    inTransaction: jest.fn(() => true),
  } as unknown as ClientSession;

  const query = {
    lean: jest.fn<() => UserQueryStub>(),
    exec: jest.fn<() => Promise<UserResult>>(() =>
      Promise.resolve(
        userResult === undefined ? { _id: authenticatedUserId } : userResult,
      ),
    ),
  };

  query.lean.mockReturnValue(query);

  const findOneAndUpdate = jest.fn<FindOneAndUpdate>(() => query);

  const consumeLinkGrant = jest.fn<
    GoogleOAuthContinuationGrantService['consumeLinkGrant']
  >(() =>
    Promise.resolve({
      providerAccountId: GOOGLE_SUBJECT,
      email: 'user@example.com',
      targetUserId: authenticatedUserId,
    }),
  );

  const hasGoogleLinkConflict = jest.fn<
    OAuthIdentityService['hasGoogleLinkConflict']
  >(() => Promise.resolve(false));

  const createGoogleIdentity = jest.fn<
    OAuthIdentityService['createGoogleIdentity']
  >(() => Promise.resolve());

  const record = jest.fn<AuthAuditService['record']>(() => Promise.resolve());

  const transaction = jest.fn<Connection['transaction']>((work) =>
    work(mongoSession),
  );

  const service = new GoogleOAuthAccountLinkService(
    {
      transaction,
    } as unknown as Connection,
    {
      findOneAndUpdate,
    } as unknown as Model<User>,
    {
      consumeLinkGrant,
    } as unknown as GoogleOAuthContinuationGrantService,
    {
      hasGoogleLinkConflict,
      createGoogleIdentity,
    } as unknown as OAuthIdentityService,
    {
      record,
    } as unknown as AuthAuditService,
  );

  return {
    service,
    authenticatedUserId,
    mongoSession,
    query,
    transaction,
    findOneAndUpdate,
    consumeLinkGrant,
    hasGoogleLinkConflict,
    createGoogleIdentity,
    record,
  };
};

describe('GoogleOAuthAccountLinkService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects invalid authenticated user id before opening transaction', async () => {
    const context = createContext();

    await expect(
      context.service.linkGoogleAccount(
        RAW_GRANT,
        'invalid' as unknown as Types.ObjectId,
      ),
    ).rejects.toBeInstanceOf(TypeError);

    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('links identity and writes audit in one transaction', async () => {
    const context = createContext();

    await expect(
      context.service.linkGoogleAccount(RAW_GRANT, context.authenticatedUserId),
    ).resolves.toBeUndefined();

    expect(context.transaction).toHaveBeenCalledTimes(1);

    expect(context.consumeLinkGrant).toHaveBeenCalledWith(
      RAW_GRANT,
      context.authenticatedUserId,
      context.mongoSession,
    );

    expect(context.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: context.authenticatedUserId,
        isDeleted: false,
        status: USER_STATUS.ACTIVE,
        $or: [
          {
            lockedUntil: null,
          },
          {
            lockedUntil: {
              $lte: NOW,
            },
          },
          {
            lockedUntil: {
              $exists: false,
            },
          },
        ],
      },
      {
        $set: {
          updatedAt: NOW,
        },
      },
      {
        returnDocument: 'after',
        session: context.mongoSession,
        projection: {
          _id: 1,
        },
      },
    );

    expect(context.hasGoogleLinkConflict).toHaveBeenCalledWith(
      context.authenticatedUserId,
      GOOGLE_SUBJECT,
      context.mongoSession,
    );

    expect(context.createGoogleIdentity).toHaveBeenCalledWith(
      context.authenticatedUserId,
      GOOGLE_SUBJECT,
      context.mongoSession,
    );

    expect(context.record).toHaveBeenCalledWith({
      eventCode: AuthAuditEventCode.OAUTH_LINKED,
      outcome: AuthAuditOutcome.SUCCEEDED,
      reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
      targetUserId: context.authenticatedUserId,
      actorUserId: context.authenticatedUserId,
      metadata: {
        provider: AuthAuditProvider.GOOGLE,
      },
      mongoSession: context.mongoSession,
    });
  });

  it('runs security-sensitive operations in the required order', async () => {
    const context = createContext();

    await context.service.linkGoogleAccount(
      RAW_GRANT,
      context.authenticatedUserId,
    );

    const consumeOrder = context.consumeLinkGrant.mock.invocationCallOrder[0];

    const lockOrder = context.findOneAndUpdate.mock.invocationCallOrder[0];

    const conflictOrder =
      context.hasGoogleLinkConflict.mock.invocationCallOrder[0];

    const identityOrder =
      context.createGoogleIdentity.mock.invocationCallOrder[0];

    const auditOrder = context.record.mock.invocationCallOrder[0];

    expect(consumeOrder).toBeLessThan(lockOrder);
    expect(lockOrder).toBeLessThan(conflictOrder);
    expect(conflictOrder).toBeLessThan(identityOrder);
    expect(identityOrder).toBeLessThan(auditOrder);
  });

  it('rejects an unavailable account after consuming inside transaction', async () => {
    const context = createContext(null);

    await expect(
      context.service.linkGoogleAccount(RAW_GRANT, context.authenticatedUserId),
    ).rejects.toBeInstanceOf(GoogleOAuthAccountLinkUnavailableException);

    expect(context.hasGoogleLinkConflict).not.toHaveBeenCalled();
    expect(context.createGoogleIdentity).not.toHaveBeenCalled();
    expect(context.record).not.toHaveBeenCalled();
  });

  it('rejects an identity conflict before insert and audit', async () => {
    const context = createContext();

    context.hasGoogleLinkConflict.mockResolvedValueOnce(true);

    await expect(
      context.service.linkGoogleAccount(RAW_GRANT, context.authenticatedUserId),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(context.createGoogleIdentity).not.toHaveBeenCalled();
    expect(context.record).not.toHaveBeenCalled();
  });

  it('propagates audit failure so the transaction can roll back', async () => {
    const context = createContext();
    const auditError = new Error('audit unavailable');

    context.record.mockRejectedValueOnce(auditError);

    await expect(
      context.service.linkGoogleAccount(RAW_GRANT, context.authenticatedUserId),
    ).rejects.toBe(auditError);

    expect(context.createGoogleIdentity).toHaveBeenCalledTimes(1);
  });

  it('preserves business HTTP exceptions', async () => {
    const context = createContext();
    const conflict = new ConflictException('conflict');

    context.consumeLinkGrant.mockRejectedValueOnce(conflict);

    await expect(
      context.service.linkGoogleAccount(RAW_GRANT, context.authenticatedUserId),
    ).rejects.toBe(conflict);
  });

  it('maps MongoDB infrastructure failures to service unavailable', async () => {
    const context = createContext();

    const infrastructureError = Object.assign(
      new Error('database unavailable'),
      {
        name: 'MongoNetworkError',
      },
    );

    context.consumeLinkGrant.mockRejectedValueOnce(infrastructureError);

    await expect(
      context.service.linkGoogleAccount(RAW_GRANT, context.authenticatedUserId),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not hide unknown programming errors', async () => {
    const context = createContext();
    const programmingError = new TypeError('invalid internal state');

    context.hasGoogleLinkConflict.mockRejectedValueOnce(programmingError);

    await expect(
      context.service.linkGoogleAccount(RAW_GRANT, context.authenticatedUserId),
    ).rejects.toBe(programmingError);
  });
});
