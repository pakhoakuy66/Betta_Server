import { createHash } from 'node:crypto';
import {
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  type Filter,
  type IndexDescription,
  ObjectId,
} from 'mongodb';
import {
  LEGACY_BAN_PUBLIC_REASON_CODE,
  USER_MODERATION_MIGRATABLE_FIELDS,
  USER_MODERATION_MIGRATION_VERSION,
  USER_MODERATION_SCHEMA_VERSION,
  USER_DELETION_ORIGIN_INDEX_NAME,
  USER_RESTRICTION_INDEX_NAME,
  UserDeletionOrigin,
  UserRestrictionType,
  type UserModerationMigratableField,
} from '../constants/user-moderation.constants';
import { USER_STATUS, type UserStatus } from '../schemas/user.schema';

export const DEFAULT_USER_MODERATION_MIGRATION_BATCH_SIZE = 250;
export const DEFAULT_USER_MODERATION_MIGRATION_MAX_DOCUMENTS = 10_000;
export const MAX_USER_MODERATION_MIGRATION_BATCH_SIZE = 1_000;
export const MAX_USER_MODERATION_MIGRATION_DOCUMENTS = 100_000;

export type UserModerationMigrationDirection = 'forward' | 'rollback';

type UserModerationMigrationMarkerDocument = Readonly<{
  version: number;
  migratedAt: Date;
  ownedFields: UserModerationMigratableField[];
}>;

export type UserModerationMigrationDocument = Document & {
  _id: ObjectId;
  publicId?: unknown;
  status?: unknown;
  isDeleted?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  restriction?: unknown;
  deletionOrigin?: unknown;
  restorableUntil?: unknown;
  version?: unknown;
  authzVersion?: unknown;
  moderationSchemaVersion?: unknown;
  moderationMigration?: UserModerationMigrationMarkerDocument;
};

export type UserModerationMigrationOptions = Readonly<{
  execute: boolean;
  direction: UserModerationMigrationDirection;
  batchSize: number;
  maxDocuments: number;
  afterId?: ObjectId;
  now?: Date;
}>;

export type UserModerationMigrationResult = Readonly<{
  execute: boolean;
  direction: UserModerationMigrationDirection;
  scanned: number;
  planned: number;
  matched: number;
  updated: number;
  skippedConflicts: number;
  hasMore: boolean;
  throughId: string | null;
  durationMs: number;
}>;

export type UserModerationForwardPlan = Readonly<{
  filter: Filter<UserModerationMigrationDocument>;
  set: Readonly<Record<string, unknown>>;
  ownedFields: readonly UserModerationMigratableField[];
}>;

const restrictionIndex: IndexDescription = {
  name: USER_RESTRICTION_INDEX_NAME,
  key: {
    'restriction.type': 1,
    'restriction.expiresAt': 1,
    _id: 1,
  },
  partialFilterExpression: {
    'restriction.type': { $type: 'string' },
  },
};

const deletionOriginIndex: IndexDescription = {
  name: USER_DELETION_ORIGIN_INDEX_NAME,
  key: { deletionOrigin: 1, deletedAt: 1, _id: 1 },
  partialFilterExpression: { deletionOrigin: { $type: 'string' } },
};

export const USER_MODERATION_INDEXES: readonly IndexDescription[] =
  Object.freeze([
    Object.freeze(restrictionIndex),
    Object.freeze(deletionOriginIndex),
  ]);

const MIGRATABLE_FIELD_SET = new Set<UserModerationMigratableField>(
  USER_MODERATION_MIGRATABLE_FIELDS,
);
const ALLOWED_LEGACY_STATUSES = new Set<UserStatus>(Object.values(USER_STATUS));

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Boolean(Object.prototype.hasOwnProperty.call(value, key));

const assertPositiveInteger = (
  value: number,
  name: string,
  maximum: number,
): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}`);
  }
};

const assertValidDate = (value: Date, name: string): void => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid date`);
  }
};

const readOptionalDate = (value: unknown): Date | undefined => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return undefined;
};

const assertLegacyStatus = (value: unknown): UserStatus => {
  if (
    typeof value !== 'string' ||
    !ALLOWED_LEGACY_STATUSES.has(value as UserStatus)
  ) {
    throw new TypeError('Legacy User status is not supported');
  }
  return value as UserStatus;
};

const assertOptionalVersion = (value: unknown, field: string): void => {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || Number(value) < 0)
  ) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
};

export const buildLegacyRestrictionSupportReference = (
  publicId: string,
): string =>
  `sup_migr_${createHash('sha256')
    .update(`user-moderation-v1:${publicId}`, 'utf8')
    .digest('base64url')
    .slice(0, 24)}`;

export const buildUserModerationForwardPlan = (
  document: UserModerationMigrationDocument,
  now: Date,
): UserModerationForwardPlan => {
  assertValidDate(now, 'now');
  if (!(document._id instanceof ObjectId)) {
    throw new TypeError('User migration requires an ObjectId');
  }
  if (typeof document.publicId !== 'string' || document.publicId.length < 8) {
    throw new TypeError('User migration requires a public ID');
  }
  const status = assertLegacyStatus(document.status ?? USER_STATUS.ACTIVE);
  if (
    document.isDeleted !== undefined &&
    typeof document.isDeleted !== 'boolean'
  ) {
    throw new TypeError('Legacy User isDeleted must be boolean');
  }
  assertOptionalVersion(document.version, 'version');
  assertOptionalVersion(document.authzVersion, 'authzVersion');
  if (
    document.moderationSchemaVersion !== undefined &&
    document.moderationSchemaVersion !== USER_MODERATION_SCHEMA_VERSION
  ) {
    throw new TypeError('Unsupported User moderation schema version');
  }
  if (document.moderationMigration !== undefined) {
    throw new TypeError('User already has a moderation migration marker');
  }

  const set: Record<string, unknown> = {};
  const ownedFields: UserModerationMigratableField[] = [];
  const own = (field: UserModerationMigratableField, value: unknown): void => {
    if (hasOwn(document, field)) return;
    set[field] = value;
    ownedFields.push(field);
  };

  const isDeleted = document.isDeleted === true;
  own('isDeleted', isDeleted);
  own(
    'restriction',
    status === USER_STATUS.BANNED
      ? {
          type: UserRestrictionType.INDEFINITE_BAN,
          effectiveAt:
            readOptionalDate(document.updatedAt) ??
            readOptionalDate(document.createdAt) ??
            now,
          expiresAt: null,
          supportReference: buildLegacyRestrictionSupportReference(
            document.publicId,
          ),
          publicReasonCode: LEGACY_BAN_PUBLIC_REASON_CODE,
        }
      : null,
  );
  own(
    'deletionOrigin',
    isDeleted ? UserDeletionOrigin.USER_SELF_DELETED : null,
  );
  own('restorableUntil', null);
  own('version', 0);
  own('authzVersion', 0);
  own('moderationSchemaVersion', USER_MODERATION_SCHEMA_VERSION);

  if (ownedFields.length === 0) {
    throw new TypeError('User moderation state is already complete');
  }

  set.moderationMigration = {
    version: USER_MODERATION_MIGRATION_VERSION,
    migratedAt: now,
    ownedFields,
  };

  return Object.freeze({
    filter: {
      _id: document._id,
      'moderationMigration.version': { $exists: false },
      ...Object.fromEntries(
        ownedFields.map((field) => [field, { $exists: false }]),
      ),
    },
    set: Object.freeze(set),
    ownedFields: Object.freeze([...ownedFields]),
  });
};

const forwardCandidateFilter = (
  afterId?: ObjectId,
): Filter<UserModerationMigrationDocument> => ({
  ...(afterId ? { _id: { $gt: afterId } } : {}),
  'moderationMigration.version': { $exists: false },
  $or: USER_MODERATION_MIGRATABLE_FIELDS.map((field) => ({
    [field]: { $exists: false },
  })),
});

const rollbackCandidateFilter = (
  afterId?: ObjectId,
): Filter<UserModerationMigrationDocument> => ({
  ...(afterId ? { _id: { $gt: afterId } } : {}),
  'moderationMigration.version': USER_MODERATION_MIGRATION_VERSION,
});

const scanFilter = (
  direction: UserModerationMigrationDirection,
  afterId?: ObjectId,
): Filter<UserModerationMigrationDocument> =>
  direction === 'forward'
    ? forwardCandidateFilter(afterId)
    : rollbackCandidateFilter(afterId);

const projection = {
  _id: 1,
  publicId: 1,
  status: 1,
  isDeleted: 1,
  createdAt: 1,
  updatedAt: 1,
  restriction: 1,
  deletionOrigin: 1,
  restorableUntil: 1,
  version: 1,
  authzVersion: 1,
  moderationSchemaVersion: 1,
  moderationMigration: 1,
} as const;

const buildForwardOperation = (
  document: UserModerationMigrationDocument,
  now: Date,
): AnyBulkWriteOperation<UserModerationMigrationDocument> => {
  const plan = buildUserModerationForwardPlan(document, now);
  return {
    updateOne: {
      filter: plan.filter,
      update: { $set: plan.set },
    },
  };
};

const readOwnedFields = (
  marker: UserModerationMigrationMarkerDocument | undefined,
): UserModerationMigratableField[] => {
  if (
    marker?.version !== USER_MODERATION_MIGRATION_VERSION ||
    !Array.isArray(marker.ownedFields) ||
    marker.ownedFields.length === 0 ||
    marker.ownedFields.some((field) => !MIGRATABLE_FIELD_SET.has(field))
  ) {
    throw new TypeError('Invalid User moderation migration marker');
  }
  return [...new Set(marker.ownedFields)];
};

const buildRollbackOperation = (
  document: UserModerationMigrationDocument,
): AnyBulkWriteOperation<UserModerationMigrationDocument> | null => {
  if (document.version !== 0 || document.authzVersion !== 0) return null;
  const ownedFields = readOwnedFields(document.moderationMigration);
  return {
    updateOne: {
      filter: {
        _id: document._id,
        version: 0,
        authzVersion: 0,
        'moderationMigration.version': USER_MODERATION_MIGRATION_VERSION,
        'moderationMigration.migratedAt':
          document.moderationMigration?.migratedAt,
        'moderationMigration.ownedFields': ownedFields,
      },
      update: {
        $unset: {
          ...Object.fromEntries(ownedFields.map((field) => [field, ''])),
          moderationMigration: '',
        },
      },
    },
  };
};

export const migrateUserModerationState = async (
  collection: Collection<UserModerationMigrationDocument>,
  options: UserModerationMigrationOptions,
): Promise<UserModerationMigrationResult> => {
  assertPositiveInteger(
    options.batchSize,
    'batchSize',
    MAX_USER_MODERATION_MIGRATION_BATCH_SIZE,
  );
  assertPositiveInteger(
    options.maxDocuments,
    'maxDocuments',
    MAX_USER_MODERATION_MIGRATION_DOCUMENTS,
  );
  const now = options.now ?? new Date();
  assertValidDate(now, 'now');
  const startedAt = Date.now();
  let scanned = 0;
  let planned = 0;
  let matched = 0;
  let updated = 0;
  let skippedConflicts = 0;
  let lastId = options.afterId;

  if (options.execute && options.direction === 'forward') {
    await collection.createIndexes([...USER_MODERATION_INDEXES]);
  }

  while (scanned < options.maxDocuments) {
    const limit = Math.min(options.batchSize, options.maxDocuments - scanned);
    const documents = await collection
      .find(scanFilter(options.direction, lastId), { projection })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    if (documents.length === 0) break;

    scanned += documents.length;
    lastId = documents[documents.length - 1]._id;
    const operations = documents
      .map((document) =>
        options.direction === 'forward'
          ? buildForwardOperation(document, now)
          : buildRollbackOperation(document),
      )
      .filter(
        (
          operation,
        ): operation is AnyBulkWriteOperation<UserModerationMigrationDocument> =>
          operation !== null,
      );
    planned += operations.length;
    skippedConflicts += documents.length - operations.length;
    if (!options.execute || operations.length === 0) continue;

    const result = await collection.bulkWrite(operations, { ordered: true });
    if (!result.isOk()) {
      throw new Error('MongoDB did not acknowledge User moderation migration');
    }
    matched += result.matchedCount;
    updated += result.modifiedCount;
    skippedConflicts += operations.length - result.matchedCount;
  }

  const hasMore = Boolean(
    await collection.findOne(
      scanFilter(options.direction, options.execute ? options.afterId : lastId),
      { projection: { _id: 1 } },
    ),
  );

  return Object.freeze({
    execute: options.execute,
    direction: options.direction,
    scanned,
    planned,
    matched,
    updated,
    skippedConflicts,
    hasMore,
    throughId: lastId?.toHexString() ?? null,
    durationMs: Date.now() - startedAt,
  });
};
