import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { type ClientSession, type Model, Types } from 'mongoose';

import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
  type RecordAuthAuditInput,
} from '../interfaces/auth-audit.interface';
import { AuthAuditEvent } from '../schemas/auth-audit-event.schema';
import { AuthAuditService } from './auth-audit.service';

const NOW = new Date('2026-07-18T00:00:00.000Z');

const FORBIDDEN_AUDIT_KEY_PATTERN = /password|otp|token|hash|secret/i;

const collectObjectKeys = (value: unknown): string[] => {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nestedValue]) => [key, ...collectObjectKeys(nestedValue)],
  );
};

const expectNoSensitiveFields = (value: unknown): void => {
  const leakedKeys = collectObjectKeys(value).filter((key) =>
    FORBIDDEN_AUDIT_KEY_PATTERN.test(key),
  );

  expect(leakedKeys).toEqual([]);
};

type AuditInsertManyFunction = (
  documents: Array<Record<string, unknown>>,
  options?: {
    session?: ClientSession;
  },
) => Promise<unknown>;

const createConfig = (retentionValue?: unknown): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === 'AUTH_AUDIT_RETENTION_DAYS' ? retentionValue : undefined,
    ),
  }) as unknown as ConfigService;

const createContext = (retentionValue?: unknown) => {
  const insertMany = jest.fn<AuditInsertManyFunction>((documents) =>
    Promise.resolve(documents),
  );

  const service = new AuthAuditService(
    {
      insertMany,
    } as unknown as Model<AuthAuditEvent>,
    createConfig(retentionValue),
  );

  return {
    service,
    insertMany,
  };
};

const validInput = (
  overrides: Partial<RecordAuthAuditInput> = {},
): RecordAuthAuditInput => ({
  eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
  outcome: AuthAuditOutcome.SUCCEEDED,
  reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
  targetUserId: new Types.ObjectId(),
  metadata: {
    affectedSessionCount: 2,
  },
  ...overrides,
});

const acceptedRetentionCases: Array<[unknown, number]> = [
  [undefined, 180],
  [null, 180],
  ['', 180],
  ['   ', 180],
  ['180', 180],
  [180, 180],
  ['30', 30],
  [30, 30],
  ['730', 730],
  [730, 730],
];

const rejectedRetentionCases: Array<[unknown]> = [
  [29],
  [731],
  ['29'],
  ['731'],
  ['invalid'],
  [Number.NaN],
  [{}],
  [[]],
];

const validPolicyCases: Array<Omit<RecordAuthAuditInput, 'targetUserId'>> = [
  {
    eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.LOGIN_FAILURE_THRESHOLD,
  },
  {
    eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
    metadata: {
      affectedSessionCount: 2,
    },
  },
  {
    eventCode: AuthAuditEventCode.PASSWORD_RESET,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.PASSWORD_RESET_COMPLETED,
    metadata: {
      affectedSessionCount: 3,
    },
  },
  {
    eventCode: AuthAuditEventCode.SESSION_REVOKED,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.SESSION_REVOKE_REQUESTED,
    sessionPublicId: `ses_${'a'.repeat(36)}`,
  },
  {
    eventCode: AuthAuditEventCode.SESSIONS_REVOKED_ALL,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.LOGOUT_ALL_REQUESTED,
    metadata: {
      affectedSessionCount: 4,
    },
  },
  {
    eventCode: AuthAuditEventCode.ACCOUNT_DELETED,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.ACCOUNT_DELETION_COMPLETED,
    metadata: {
      affectedSessionCount: 5,
    },
  },
  {
    eventCode: AuthAuditEventCode.REFRESH_REPLAY_DETECTED,
    outcome: AuthAuditOutcome.DENIED,
    reasonCode: AuthAuditReasonCode.REFRESH_TOKEN_REPLAY,
    sessionPublicId: `ses_${'b'.repeat(36)}`,
  },
  {
    eventCode: AuthAuditEventCode.OAUTH_LINKED,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
    metadata: {
      provider: AuthAuditProvider.GOOGLE,
    },
  },
  {
    eventCode: AuthAuditEventCode.OAUTH_UNLINKED,
    outcome: AuthAuditOutcome.SUCCEEDED,
    reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_UNLINKED,
    metadata: {
      provider: AuthAuditProvider.GOOGLE,
    },
  },
];

describe('AuthAuditService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(acceptedRetentionCases)(
    'accepts retention %p as %i days',
    async (retentionValue, expectedDays) => {
      jest.useFakeTimers().setSystemTime(NOW);

      const { service, insertMany } = createContext(retentionValue);

      await service.record(validInput());

      const document = insertMany.mock.calls[0][0][0];

      expect(document.expiresAt).toEqual(
        new Date(NOW.getTime() + expectedDays * 86_400_000),
      );
    },
  );

  it.each(rejectedRetentionCases)(
    'rejects unsafe retention value %p',
    (retentionValue) => {
      expect(() => createContext(retentionValue)).toThrow(
        'AUTH_AUDIT_RETENTION_DAYS must be an integer from 30 to 730',
      );
    },
  );

  it('stores only the allowlisted payload', async () => {
    jest.useFakeTimers().setSystemTime(NOW);

    const { service, insertMany } = createContext();

    await service.record(validInput());

    const document = insertMany.mock.calls[0][0][0];

    expect(document).toEqual(
      expect.objectContaining({
        eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
        targetUserId: expect.any(Types.ObjectId),
        actorUserId: null,
        metadata: {
          affectedSessionCount: 2,
        },
        expiresAt: expect.any(Date),
      }),
    );

    expectNoSensitiveFields(document);
  });

  it.each(validPolicyCases)(
    'accepts valid policy for $eventCode',
    async (policyInput) => {
      const { service, insertMany } = createContext();

      await expect(
        service.record({
          targetUserId: new Types.ObjectId(),
          ...policyInput,
        }),
      ).resolves.toBeUndefined();

      expect(insertMany).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects invalid event, outcome and reason', async () => {
    const { service } = createContext();

    await expect(
      service.record(
        validInput({
          eventCode: 'invalid' as AuthAuditEventCode,
        }),
      ),
    ).rejects.toThrow('Invalid auth audit event code');

    await expect(
      service.record(
        validInput({
          outcome: AuthAuditOutcome.DENIED,
        }),
      ),
    ).rejects.toThrow('Invalid outcome for auth audit event');

    await expect(
      service.record(
        validInput({
          reasonCode: AuthAuditReasonCode.PASSWORD_RESET_COMPLETED,
        }),
      ),
    ).rejects.toThrow('Invalid reason for auth audit event');
  });

  it('requires actual ObjectId instances for target and actor', async () => {
    const { service } = createContext();

    await expect(
      service.record(
        validInput({
          targetUserId:
            new Types.ObjectId().toString() as unknown as Types.ObjectId,
        }),
      ),
    ).rejects.toThrow('targetUserId must be a MongoDB ObjectId');

    await expect(
      service.record(
        validInput({
          actorUserId:
            new Types.ObjectId().toString() as unknown as Types.ObjectId,
        }),
      ),
    ).rejects.toThrow('actorUserId must be a MongoDB ObjectId');
  });

  it('enforces required and forbidden sessions', async () => {
    const { service } = createContext();

    await expect(
      service.record({
        eventCode: AuthAuditEventCode.SESSION_REVOKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.SESSION_REVOKE_REQUESTED,
        targetUserId: new Types.ObjectId(),
      }),
    ).rejects.toThrow('sessionPublicId is required for this event');

    await expect(
      service.record(
        validInput({
          sessionPublicId: `ses_${'c'.repeat(36)}`,
        }),
      ),
    ).rejects.toThrow('sessionPublicId is not allowed for this event');
  });

  it('validates session identifier format', async () => {
    const { service } = createContext();

    await expect(
      service.record({
        eventCode: AuthAuditEventCode.SESSION_REVOKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.SESSION_REVOKE_REQUESTED,
        targetUserId: new Types.ObjectId(),
        sessionPublicId: 'invalid',
      }),
    ).rejects.toThrow('Invalid sessionPublicId');
  });

  it('enforces provider policy', async () => {
    const { service } = createContext();

    await expect(
      service.record({
        eventCode: AuthAuditEventCode.OAUTH_LINKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
        targetUserId: new Types.ObjectId(),
      }),
    ).rejects.toThrow('provider is required for this event');

    await expect(
      service.record(
        validInput({
          metadata: {
            affectedSessionCount: 1,
            provider: AuthAuditProvider.GOOGLE,
          },
        }),
      ),
    ).rejects.toThrow('provider is not allowed for this event');
  });

  it('rejects session count on unsupported events', async () => {
    const { service } = createContext();

    await expect(
      service.record({
        eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.LOGIN_FAILURE_THRESHOLD,
        targetUserId: new Types.ObjectId(),
        metadata: {
          affectedSessionCount: 1,
        },
      }),
    ).rejects.toThrow('affectedSessionCount is not allowed for this event');
  });

  it('rejects unknown metadata keys', async () => {
    const { service } = createContext();

    await expect(
      service.record(
        validInput({
          metadata: {
            affectedSessionCount: 2,
            token: 'must-not-be-stored',
          } as unknown as RecordAuthAuditInput['metadata'],
        }),
      ),
    ).rejects.toThrow('Unsupported audit metadata: token');
  });

  it('maps non-transaction persistence errors to 503', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { service, insertMany } = createContext();

    insertMany.mockRejectedValue(new Error('database unavailable'));

    await expect(service.record(validInput())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rethrows the same MongoDB error inside a transaction', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { service, insertMany } = createContext();

    const mongoError = Object.assign(new Error('transient write failure'), {
      code: 112,
      errorLabels: ['TransientTransactionError'],
    });

    const mongoSession = {} as ClientSession;

    insertMany.mockRejectedValue(mongoError);

    await expect(
      service.record(
        validInput({
          mongoSession,
        }),
      ),
    ).rejects.toBe(mongoError);

    expect(insertMany).toHaveBeenCalledWith([expect.any(Object)], {
      session: mongoSession,
    });
  });

  it('rejects unsupported Facebook audit provider', async () => {
    const { service } = createContext();

    await expect(
      service.record({
        eventCode: AuthAuditEventCode.OAUTH_LINKED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.OAUTH_ACCOUNT_LINKED,
        targetUserId: new Types.ObjectId(),
        metadata: {
          provider: 'facebook' as AuthAuditProvider,
        },
      }),
    ).rejects.toThrow('Invalid auth provider');
  });
});
