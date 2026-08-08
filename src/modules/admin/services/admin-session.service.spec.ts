import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  type ClientSession,
  type Connection,
  type Model,
  Types,
} from 'mongoose';
import { createAdminPolicy } from '../config/admin-policy.config';
import {
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import {
  ADMIN_ACCESS_TOKEN_ISSUER,
  ADMIN_JWT_ALGORITHM,
  ADMIN_REFRESH_TOKEN_AUDIENCE,
  ADMIN_REFRESH_TOKEN_USE,
} from '../constants/admin-auth-token.constants';
import {
  AdminAuditAction,
  AdminAuditOutcome,
} from '../constants/admin-audit.constants';
import { AdminSessionRevokeReason } from '../constants/admin-session.constants';
import { type AdminSessionAccount } from '../interfaces/admin-session.interface';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminSession } from '../schemas/admin-session.schema';
import { AdminAuditService } from './admin-audit.service';
import { AdminSessionService } from './admin-session.service';

type AsyncFunction = (...args: unknown[]) => Promise<unknown>;
type QueryChain = {
  select: jest.Mock<(projection: string) => QueryChain>;
  lean: jest.Mock<() => QueryChain>;
  sort: jest.Mock<(sort: unknown) => QueryChain>;
  skip: jest.Mock<(skip: number) => QueryChain>;
  limit: jest.Mock<(limit: number) => QueryChain>;
  exec: jest.Mock<() => Promise<unknown>>;
};

const activeSession = {
  inTransaction: () => true,
} as ClientSession;

const account: AdminSessionAccount = {
  _id: new Types.ObjectId('6a3924c4f5a540da96575f6a'),
  publicId: 'adm_23456789ABCD',
  username: 'owner',
  displayName: 'Owner',
  role: AdminRole.SUPER_ADMIN,
  credentialVersion: 1,
  authzVersion: 2,
  permissionVersion: 3,
};

const refreshAccount = {
  ...account,
  status: AdminAccountStatus.ACTIVE,
  mfaStatus: AdminMfaStatus.ACTIVE,
  mustChangePassword: false,
  lockedAt: null,
  deletedAt: null,
};

const createQuery = (result: unknown): QueryChain => {
  const chain: QueryChain = {
    select: jest.fn<(projection: string) => QueryChain>(),
    lean: jest.fn<() => QueryChain>(),
    sort: jest.fn<(sort: unknown) => QueryChain>(),
    skip: jest.fn<(skip: number) => QueryChain>(),
    limit: jest.fn<(limit: number) => QueryChain>(),
    exec: jest.fn<() => Promise<unknown>>(() => Promise.resolve(result)),
  };
  chain.select.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
};

const createContext = () => {
  const create = jest.fn<AsyncFunction>(() => Promise.resolve([]));
  const findOne = jest.fn<(...args: unknown[]) => QueryChain>();
  const find = jest.fn<(...args: unknown[]) => QueryChain>();
  const updateOne = jest.fn<AsyncFunction>();
  const updateMany = jest.fn<AsyncFunction>();
  const exists = jest.fn<(...args: unknown[]) => QueryChain>();
  const accountFindOne = jest.fn<(...args: unknown[]) => QueryChain>();
  const transaction = jest.fn<
    (
      operation: (session: ClientSession) => Promise<unknown>,
    ) => Promise<unknown>
  >((operation) => operation(activeSession));
  const auditRecord = jest.fn<AdminAuditService['record']>(() =>
    Promise.resolve(`aaud_${'2'.repeat(16)}`),
  );
  const key = Object.freeze({ id: 'refresh-v1', key: Buffer.alloc(32, 7) });
  const secrets: AdminSecrets = {
    current: (purpose) => {
      if (purpose !== AdminSecretPurpose.REFRESH_TOKEN_SIGNING) {
        throw new Error('unexpected purpose');
      }
      return key;
    },
    resolve: (purpose, keyId) => {
      if (
        purpose !== AdminSecretPurpose.REFRESH_TOKEN_SIGNING ||
        keyId !== key.id
      ) {
        throw new Error('unknown key');
      }
      return key;
    },
    candidates: () => [key],
    describe: () => [],
    toJSON: () => ({ redacted: true, keyrings: [] }),
  };
  const sessionModel = {
    create,
    findOne,
    find,
    updateOne,
    updateMany,
    exists,
  } as unknown as Model<AdminSession>;
  const accountModel = {
    findOne: accountFindOne,
  } as unknown as Model<AdminAccount>;
  const connection = { transaction } as unknown as Connection;
  const auditService = { record: auditRecord } as unknown as AdminAuditService;
  const jwtService = new JwtService();
  const policy = createAdminPolicy({ get: () => undefined });
  const service = new AdminSessionService(
    sessionModel,
    accountModel,
    jwtService,
    secrets,
    policy,
    connection,
    auditService,
  );
  return {
    service,
    create,
    findOne,
    find,
    updateOne,
    updateMany,
    exists,
    accountFindOne,
    transaction,
    auditRecord,
    jwtService,
    key,
    policy,
  };
};

const signRefreshToken = async (
  context: ReturnType<typeof createContext>,
  input: Readonly<{
    subject?: string;
    issuer?: string;
    audience?: string;
    keyId?: string;
    algorithm?: 'HS256' | 'HS384';
    claims?: Record<string, unknown>;
  }> = {},
): Promise<string> =>
  context.jwtService.signAsync(
    {
      tokenUse: ADMIN_REFRESH_TOKEN_USE,
      sid: 'ases_23456789ABCDEFGH',
      family: 'afam_23456789ABCDEFGH',
      version: 0,
      credentialVersion: 1,
      authzVersion: 2,
      permissionVersion: 3,
      ...input.claims,
    },
    {
      secret: context.key.key,
      algorithm: input.algorithm ?? ADMIN_JWT_ALGORITHM,
      keyid: input.keyId ?? context.key.id,
      issuer: input.issuer ?? ADMIN_ACCESS_TOKEN_ISSUER,
      audience: input.audience ?? ADMIN_REFRESH_TOKEN_AUDIENCE,
      subject: input.subject ?? account.publicId,
      expiresIn: context.policy.session.refreshTokenTtlSeconds,
    },
  );

const createCredential = async (context: ReturnType<typeof createContext>) => {
  const credential = await context.service.createSession(
    account,
    { userAgent: 'Mozilla Chrome/120 Windows' },
    activeSession,
  );
  const call = context.create.mock.calls[0]?.[0] as
    | Array<Record<string, unknown>>
    | undefined;
  const document = call?.[0];
  if (!document) throw new Error('Thiếu Admin session fixture');
  return { credential, document };
};

describe('AdminSessionService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a hashed session and audit in the caller transaction', async () => {
    const context = createContext();
    const { credential, document } = await createCredential(context);

    expect(document.refreshTokenHash).toMatch(/^sha256-v1:[a-f0-9]{64}$/u);
    expect(document.refreshTokenHash).not.toContain(credential.refreshToken);
    expect(document.deviceLabel).toBe('Chrome trên Windows');
    expect(context.create).toHaveBeenCalledWith([expect.any(Object)], {
      session: activeSession,
    });
    expect(context.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ mongoSession: activeSession }),
    );
  });

  it('rejects create when the caller session has no active transaction', async () => {
    const context = createContext();
    await expect(
      context.service.createSession(account, {}, {
        inTransaction: () => false,
      } as ClientSession),
    ).rejects.toThrow('transaction active');
    expect(context.create).not.toHaveBeenCalled();
  });

  it('rotates with compare-and-set and returns an explicit account projection', async () => {
    const context = createContext();
    const { credential, document } = await createCredential(context);
    context.findOne.mockReturnValue(
      createQuery({
        _id: new Types.ObjectId(),
        ...document,
      }),
    );
    context.accountFindOne.mockReturnValue(createQuery(refreshAccount));
    context.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await context.service.rotateRefreshToken(
      credential.refreshToken,
    );

    expect(result.refreshToken).not.toBe(credential.refreshToken);
    expect(result.account).toEqual(account);
    expect(result.account).not.toHaveProperty('status');
    expect(context.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 0 }),
      expect.objectContaining({
        $set: expect.objectContaining({ tokenVersion: 1 }),
      }),
      expect.objectContaining({
        session: activeSession,
        runValidators: true,
      }),
    );
    expect(context.auditRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.SESSION_ROTATED,
        outcome: AdminAuditOutcome.SUCCEEDED,
        metadata: { beforeVersion: 0, afterVersion: 1 },
        mongoSession: activeSession,
      }),
    );
  });

  it('revokes the family and audits detected refresh replay', async () => {
    const context = createContext();
    const { credential, document } = await createCredential(context);
    context.auditRecord.mockClear();
    context.findOne.mockReturnValue(
      createQuery({
        _id: new Types.ObjectId(),
        ...document,
        tokenVersion: 1,
      }),
    );
    context.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(
      context.service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(context.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: credential.sessionPublicId }),
      {
        $set: expect.objectContaining({
          revokeReason: AdminSessionRevokeReason.REFRESH_REPLAY,
        }),
      },
      expect.objectContaining({ session: activeSession }),
    );
    expect(context.auditRecord).toHaveBeenCalledTimes(1);
  });

  it('returns generic 401 for a CAS loser without revoking or auditing replay', async () => {
    const context = createContext();
    const { credential, document } = await createCredential(context);
    context.auditRecord.mockClear();
    context.findOne.mockReturnValue(
      createQuery({ _id: new Types.ObjectId(), ...document }),
    );
    context.accountFindOne.mockReturnValue(createQuery(refreshAccount));
    context.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(
      context.service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(context.updateOne).toHaveBeenCalledTimes(1);
    expect(context.auditRecord).not.toHaveBeenCalled();
  });

  it('rolls back the rotation contract when SESSION_ROTATED audit fails', async () => {
    const context = createContext();
    const { credential, document } = await createCredential(context);
    context.auditRecord.mockClear();
    context.findOne.mockReturnValue(
      createQuery({ _id: new Types.ObjectId(), ...document }),
    );
    context.accountFindOne.mockReturnValue(createQuery(refreshAccount));
    context.updateOne.mockResolvedValue({ modifiedCount: 1 });
    context.auditRecord.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      context.service.rotateRefreshToken(credential.refreshToken),
    ).rejects.toThrow('audit unavailable');
    expect(context.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.SESSION_ROTATED,
        mongoSession: activeSession,
      }),
    );
  });

  it('rejects invalid refresh JWT boundaries before database access', async () => {
    const invalidTokens: string[] = [];
    const tokenContext = createContext();
    invalidTokens.push(
      await signRefreshToken(tokenContext, { issuer: 'wrong-issuer' }),
      await signRefreshToken(tokenContext, { audience: 'wrong-audience' }),
      await signRefreshToken(tokenContext, {
        claims: { tokenUse: 'admin_access' },
      }),
      await signRefreshToken(tokenContext, { keyId: 'unknown-key' }),
      await signRefreshToken(tokenContext, { algorithm: 'HS384' }),
      await signRefreshToken(tokenContext, { claims: { extra: true } }),
    );
    invalidTokens.push(
      await tokenContext.jwtService.signAsync(
        {
          tokenUse: ADMIN_REFRESH_TOKEN_USE,
          sid: 'ases_23456789ABCDEFGH',
          family: 'afam_23456789ABCDEFGH',
          version: 0,
          credentialVersion: 1,
          authzVersion: 2,
          permissionVersion: 3,
        },
        {
          secret: Buffer.alloc(32, 99),
          algorithm: ADMIN_JWT_ALGORITHM,
          keyid: tokenContext.key.id,
          issuer: ADMIN_ACCESS_TOKEN_ISSUER,
          audience: ADMIN_REFRESH_TOKEN_AUDIENCE,
          subject: account.publicId,
          expiresIn: tokenContext.policy.session.refreshTokenTtlSeconds,
        },
      ),
    );
    const validToken = await signRefreshToken(tokenContext);
    const payloadSegment = validToken.split('.')[1];
    if (!payloadSegment) throw new Error('Thiếu JWT payload fixture');
    const extraHeaderSegment = Buffer.from(
      JSON.stringify({
        alg: ADMIN_JWT_ALGORITHM,
        typ: 'JWT',
        kid: tokenContext.key.id,
        extra: true,
      }),
      'utf8',
    ).toString('base64url');
    const signingInput = `${extraHeaderSegment}.${payloadSegment}`;
    const signature = createHmac('sha256', tokenContext.key.key)
      .update(signingInput, 'utf8')
      .digest('base64url');
    invalidTokens.push(`${signingInput}.${signature}`);

    for (const token of invalidTokens) {
      const context = createContext();
      await expect(
        context.service.rotateRefreshToken(token),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(context.findOne).not.toHaveBeenCalled();
    }
  });

  it('revokes sessions for every ineligible account state', async () => {
    const cases = [
      { status: AdminAccountStatus.LOCKED },
      { status: AdminAccountStatus.SOFT_DELETED, deletedAt: new Date() },
      { mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT },
      { mustChangePassword: true },
      { lockedAt: new Date() },
    ];

    for (const accountOverride of cases) {
      const context = createContext();
      const { credential, document } = await createCredential(context);
      context.auditRecord.mockClear();
      context.findOne.mockReturnValue(
        createQuery({ _id: new Types.ObjectId(), ...document }),
      );
      context.accountFindOne.mockReturnValue(
        createQuery({ ...refreshAccount, ...accountOverride }),
      );
      context.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await expect(
        context.service.rotateRefreshToken(credential.refreshToken),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(context.updateOne).toHaveBeenCalledWith(
        expect.any(Object),
        {
          $set: expect.objectContaining({
            revokeReason: AdminSessionRevokeReason.ACCOUNT_INELIGIBLE,
          }),
        },
        expect.objectContaining({ session: activeSession }),
      );
    }
  });

  it('revokes sessions when any security version changes', async () => {
    const cases = [
      { credentialVersion: 2 },
      { authzVersion: 3 },
      { permissionVersion: 4 },
    ];

    for (const versionOverride of cases) {
      const context = createContext();
      const { credential, document } = await createCredential(context);
      context.auditRecord.mockClear();
      context.findOne.mockReturnValue(
        createQuery({ _id: new Types.ObjectId(), ...document }),
      );
      context.accountFindOne.mockReturnValue(
        createQuery({ ...refreshAccount, ...versionOverride }),
      );
      context.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await expect(
        context.service.rotateRefreshToken(credential.refreshToken),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(context.updateOne).toHaveBeenCalledWith(
        expect.any(Object),
        {
          $set: expect.objectContaining({
            revokeReason: AdminSessionRevokeReason.AUTHORIZATION_CHANGED,
          }),
        },
        expect.objectContaining({ session: activeSession }),
      );
    }
  });

  it('lists only owner sessions with stable sort and public projection', async () => {
    const context = createContext();
    const now = new Date();
    const query = createQuery([
      {
        publicId: 'ases_23456789ABCDEFGH',
        deviceLabel: 'Chrome trên Windows',
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 1000),
        refreshTokenHash: 'must-not-leak',
      },
    ]);
    context.find.mockReturnValue(query);

    const result = await context.service.listActiveSessions(
      account._id,
      'ases_23456789ABCDEFGH',
      1,
      20,
    );

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: 'ases_23456789ABCDEFGH',
        isCurrent: true,
      }),
    );
    expect(result.items[0]).not.toHaveProperty('refreshTokenHash');
    expect(query.sort).toHaveBeenCalledWith({
      lastUsedAt: -1,
      publicId: 1,
    });
    expect(query.limit).toHaveBeenCalledWith(21);
    expect(result.pagination).toEqual({ page: 1, limit: 20, hasMore: false });
  });

  it('returns hasMore without executing a total-count query', async () => {
    const context = createContext();
    const now = new Date();
    const records = Array.from({ length: 3 }, (_, index) => ({
      publicId: `ases_23456789ABCDEFG${String.fromCharCode(72 + index)}`,
      deviceLabel: 'Chrome trên Windows',
      createdAt: now,
      lastUsedAt: new Date(now.getTime() - index),
      expiresAt: new Date(now.getTime() + 60_000),
    }));
    const current = records[0];
    if (!current) throw new Error('Thiếu session pagination fixture');
    const query = createQuery(records);
    context.find.mockReturnValue(query);

    const result = await context.service.listActiveSessions(
      account._id,
      current.publicId,
      1,
      2,
    );

    expect(query.limit).toHaveBeenCalledWith(3);
    expect(result.items).toHaveLength(2);
    expect(result.pagination).toEqual({ page: 1, limit: 2, hasMore: true });
  });

  it('prevents revoking current session through revoke-other', async () => {
    const context = createContext();
    await expect(
      context.service.revokeOtherSession(
        account,
        'ases_23456789ABCDEFGH',
        'ases_23456789ABCDEFGH',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('revokes all active owner sessions and records affected count', async () => {
    const context = createContext();
    context.updateMany.mockResolvedValue({ modifiedCount: 3 });
    const count = await context.service.logoutAllSelf(account);
    expect(count).toBe(3);
    expect(context.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { affectedSessionCount: 3 },
        mongoSession: activeSession,
      }),
    );
  });

  it('maps Mongo infrastructure failure to a sanitized 503', async () => {
    const context = createContext();
    const brokenQuery = createQuery([]);
    brokenQuery.exec.mockRejectedValue(
      Object.assign(new Error('mongodb://secret'), {
        name: 'MongoNetworkError',
      }),
    );
    context.find.mockReturnValue(brokenQuery);

    await expect(
      context.service.listActiveSessions(
        account._id,
        'ases_23456789ABCDEFGH',
        1,
        20,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
