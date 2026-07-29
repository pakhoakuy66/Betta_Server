import { ConflictException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { type ClientSession, type Model, Types } from 'mongoose';
import { OAuthIdentity, OAuthProvider } from '../schemas/oauth-identity.schema';
import { OAuthIdentityService } from './oauth-identity.service';

type ResolveResult =
  | {
      userId: Types.ObjectId;
    }
  | {
      _id: Types.ObjectId;
    }
  | null;

type QueryStub = {
  select: jest.Mock<(value: Record<string, number>) => QueryStub>;
  lean: jest.Mock<() => QueryStub>;
  session: jest.Mock<(value: ClientSession) => QueryStub>;
  exec: jest.Mock<() => Promise<ResolveResult>>;
};

type InsertInput = {
  userId: Types.ObjectId;
  provider: OAuthProvider;
  providerAccountId: string;
};

type InsertMany = (
  documents: InsertInput[],
  options: {
    session: ClientSession;
    ordered: boolean;
  },
) => Promise<unknown>;

const INVALID_SUBJECTS = [
  '',
  ' ',
  ' google-sub',
  'google-sub ',
  'google sub',
  'google\nsub',
  'google\tsub',
  'a'.repeat(256),
];

const queryStub = (result: ResolveResult): QueryStub => {
  const query = {
    select: jest.fn<(value: Record<string, number>) => QueryStub>(),
    lean: jest.fn<() => QueryStub>(),
    session: jest.fn<(value: ClientSession) => QueryStub>(),
    exec: jest.fn<() => Promise<ResolveResult>>(() => Promise.resolve(result)),
  };

  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  query.session.mockReturnValue(query);

  return query;
};

const createContext = (result: ResolveResult = null) => {
  const query = queryStub(result);

  const findOne = jest.fn<(filter: Record<string, unknown>) => QueryStub>(
    () => query,
  );

  const findOneAndDelete = jest.fn<
    (filter: Record<string, unknown>) => QueryStub
  >(() => query);

  const insertMany = jest.fn<InsertMany>(() => Promise.resolve([]));

  const service = new OAuthIdentityService({
    findOne,
    findOneAndDelete,
    insertMany,
  } as unknown as Model<OAuthIdentity>);

  return {
    service,
    query,
    findOne,
    findOneAndDelete,
    insertMany,
  };
};

describe('OAuthIdentityService', () => {
  describe('resolveGoogleUserId', () => {
    it('resolves exact subject without normalization', async () => {
      const userId = new Types.ObjectId();

      const { service, findOne, query } = createContext({
        userId,
      });

      await expect(service.resolveGoogleUserId('AbC-123')).resolves.toBe(
        userId,
      );

      expect(findOne).toHaveBeenCalledWith({
        provider: OAuthProvider.GOOGLE,
        providerAccountId: 'AbC-123',
      });

      expect(query.select).toHaveBeenCalledWith({
        userId: 1,
        _id: 0,
      });

      expect(query.session).not.toHaveBeenCalled();
    });

    it('returns null when identity does not exist', async () => {
      const { service } = createContext();

      await expect(service.resolveGoogleUserId('AbC-123')).resolves.toBeNull();
    });

    it('passes optional transaction session', async () => {
      const mongoSession = {} as ClientSession;

      const { service, query } = createContext();

      await service.resolveGoogleUserId('AbC-123', mongoSession);

      expect(query.session).toHaveBeenCalledTimes(1);

      expect(query.session).toHaveBeenCalledWith(mongoSession);
    });

    it.each(INVALID_SUBJECTS)('rejects invalid subject %p', async (subject) => {
      const { service, findOne } = createContext();

      await expect(service.resolveGoogleUserId(subject)).rejects.toBeInstanceOf(
        TypeError,
      );

      expect(findOne).not.toHaveBeenCalled();
    });
  });

  describe('hasGoogleLinkConflict', () => {
    it('checks subject and user conflict in the same transaction', async () => {
      const userId = new Types.ObjectId();
      const mongoSession = {} as ClientSession;
      const { service, findOne, query } = createContext({
        _id: new Types.ObjectId(),
      });

      await expect(
        service.hasGoogleLinkConflict(userId, 'AbC-123', mongoSession),
      ).resolves.toBe(true);

      expect(findOne).toHaveBeenCalledWith({
        provider: OAuthProvider.GOOGLE,
        $or: [{ providerAccountId: 'AbC-123' }, { userId }],
      });
      expect(query.select).toHaveBeenCalledWith({ _id: 1 });
      expect(query.session).toHaveBeenCalledWith(mongoSession);
    });

    it('returns false when no conflict exists', async () => {
      const { service } = createContext();

      await expect(
        service.hasGoogleLinkConflict(
          new Types.ObjectId(),
          'AbC-123',
          {} as ClientSession,
        ),
      ).resolves.toBe(false);
    });

    it('rejects invalid user id before querying', async () => {
      const { service, findOne } = createContext();

      await expect(
        service.hasGoogleLinkConflict(
          'invalid' as unknown as Types.ObjectId,
          'AbC-123',
          {} as ClientSession,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      expect(findOne).not.toHaveBeenCalled();
    });

    it('rejects missing transaction session before querying', async () => {
      const { service, findOne } = createContext();

      await expect(
        service.hasGoogleLinkConflict(
          new Types.ObjectId(),
          'AbC-123',
          undefined as unknown as ClientSession,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      expect(findOne).not.toHaveBeenCalled();
    });

    it.each(INVALID_SUBJECTS)(
      'rejects invalid conflict subject %p',
      async (subject) => {
        const { service, findOne } = createContext();

        await expect(
          service.hasGoogleLinkConflict(
            new Types.ObjectId(),
            subject,
            {} as ClientSession,
          ),
        ).rejects.toBeInstanceOf(TypeError);

        expect(findOne).not.toHaveBeenCalled();
      },
    );

    it('rethrows the original database error', async () => {
      const originalError = new Error('database unavailable');
      const { service, query } = createContext();

      query.exec.mockRejectedValueOnce(originalError);

      await expect(
        service.hasGoogleLinkConflict(
          new Types.ObjectId(),
          'AbC-123',
          {} as ClientSession,
        ),
      ).rejects.toBe(originalError);
    });
  });

  describe('createGoogleIdentity', () => {
    it('inserts exact identity using required transaction', async () => {
      const userId = new Types.ObjectId();

      const mongoSession = {} as ClientSession;

      const { service, insertMany } = createContext();

      await service.createGoogleIdentity(userId, 'AbC-123', mongoSession);

      expect(insertMany).toHaveBeenCalledWith(
        [
          {
            userId,
            provider: OAuthProvider.GOOGLE,
            providerAccountId: 'AbC-123',
          },
        ],
        {
          session: mongoSession,
          ordered: true,
        },
      );
    });

    it.each(INVALID_SUBJECTS)('rejects invalid subject %p', async (subject) => {
      const { service, insertMany } = createContext();

      await expect(
        service.createGoogleIdentity(
          new Types.ObjectId(),
          subject,
          {} as ClientSession,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      expect(insertMany).not.toHaveBeenCalled();
    });

    it('rejects invalid userId', async () => {
      const { service } = createContext();

      await expect(
        service.createGoogleIdentity(
          'invalid' as unknown as Types.ObjectId,
          'AbC-123',
          {} as ClientSession,
        ),
      ).rejects.toThrow('userId must be a MongoDB ObjectId');
    });

    it('rejects missing transaction session', async () => {
      const { service } = createContext();

      await expect(
        service.createGoogleIdentity(
          new Types.ObjectId(),
          'AbC-123',
          undefined as unknown as ClientSession,
        ),
      ).rejects.toThrow('mongoSession is required');
    });

    it.each([11000, '11000'])(
      'maps duplicate code %p to conflict',
      async (code) => {
        const { service, insertMany } = createContext();

        insertMany.mockRejectedValueOnce(
          Object.assign(new Error('duplicate'), { code }),
        );

        await expect(
          service.createGoogleIdentity(
            new Types.ObjectId(),
            'AbC-123',
            {} as ClientSession,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      },
    );

    it('rethrows original non-duplicate error', async () => {
      const originalError = new Error('database unavailable');

      const { service, insertMany } = createContext();

      insertMany.mockRejectedValueOnce(originalError);

      await expect(
        service.createGoogleIdentity(
          new Types.ObjectId(),
          'AbC-123',
          {} as ClientSession,
        ),
      ).rejects.toBe(originalError);
    });
  });

  describe('deleteGoogleIdentity', () => {
    it('deletes only Google identity in an active transaction', async () => {
      const userId = new Types.ObjectId();

      const mongoSession = {
        inTransaction: jest.fn(() => true),
      } as unknown as ClientSession;

      const { service, findOneAndDelete, query } = createContext({
        _id: new Types.ObjectId(),
      });

      await expect(
        service.deleteGoogleIdentity(userId, mongoSession),
      ).resolves.toBe(true);

      expect(findOneAndDelete).toHaveBeenCalledWith({
        userId,
        provider: OAuthProvider.GOOGLE,
      });

      expect(query.select).toHaveBeenCalledWith({
        _id: 1,
      });

      expect(query.session).toHaveBeenCalledWith(mongoSession);
    });

    it('returns false when Google identity does not exist', async () => {
      const mongoSession = {
        inTransaction: jest.fn(() => true),
      } as unknown as ClientSession;

      const { service } = createContext(null);

      await expect(
        service.deleteGoogleIdentity(new Types.ObjectId(), mongoSession),
      ).resolves.toBe(false);
    });

    it('rejects an invalid user id before deleting', async () => {
      const mongoSession = {
        inTransaction: jest.fn(() => true),
      } as unknown as ClientSession;

      const { service, findOneAndDelete } = createContext();

      await expect(
        service.deleteGoogleIdentity(
          'invalid' as unknown as Types.ObjectId,
          mongoSession,
        ),
      ).rejects.toThrow('userId must be a MongoDB ObjectId');

      expect(findOneAndDelete).not.toHaveBeenCalled();
    });

    it('rejects a missing session before deleting', async () => {
      const { service, findOneAndDelete } = createContext();

      await expect(
        service.deleteGoogleIdentity(
          new Types.ObjectId(),
          undefined as unknown as ClientSession,
        ),
      ).rejects.toThrow('mongoSession is required');

      expect(findOneAndDelete).not.toHaveBeenCalled();
    });

    it('rejects a session outside an active transaction before deleting', async () => {
      const mongoSession = {
        inTransaction: jest.fn(() => false),
      } as unknown as ClientSession;

      const { service, findOneAndDelete } = createContext();

      await expect(
        service.deleteGoogleIdentity(new Types.ObjectId(), mongoSession),
      ).rejects.toThrow('mongoSession must be in an active transaction');

      expect(findOneAndDelete).not.toHaveBeenCalled();
    });
  });
});
