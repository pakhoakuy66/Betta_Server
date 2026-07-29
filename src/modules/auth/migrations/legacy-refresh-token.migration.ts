import {
  type Collection,
  type Document,
  type Filter,
  type ObjectId,
} from 'mongodb';

export const DEFAULT_MIGRATION_BATCH_SIZE = 500;
export const DEFAULT_MIGRATION_MAX_DOCUMENTS = 10_000;

export const MAX_MIGRATION_BATCH_SIZE = 1_000;
export const MAX_MIGRATION_DOCUMENTS = 100_000;

export type LegacyRefreshTokenUser = Document & {
  _id: ObjectId;
  refreshToken?: unknown;
};

export type LegacyRefreshTokenMigrationOptions = {
  execute: boolean;
  batchSize: number;
  maxDocuments: number;
};

export type LegacyRefreshTokenMigrationResult = {
  execute: boolean;
  scanned: number;
  planned: number;
  matched: number;
  updated: number;
  hasMore: boolean;
  throughId: string | null;
  durationMs: number;
};

const legacyTokenFilter: Filter<LegacyRefreshTokenUser> = {
  refreshToken: { $exists: true },
};

function assertPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} phải là số nguyên từ 1 đến ${maximum}`);
  }
}

function buildScanFilter(afterId?: ObjectId): Filter<LegacyRefreshTokenUser> {
  if (!afterId) {
    return legacyTokenFilter;
  }

  return {
    $and: [
      legacyTokenFilter,
      {
        _id: { $gt: afterId },
      },
    ],
  };
}

export async function migrateLegacyRefreshTokens(
  collection: Collection<LegacyRefreshTokenUser>,
  options: LegacyRefreshTokenMigrationOptions,
): Promise<LegacyRefreshTokenMigrationResult> {
  assertPositiveInteger(
    options.batchSize,
    'batchSize',
    MAX_MIGRATION_BATCH_SIZE,
  );

  assertPositiveInteger(
    options.maxDocuments,
    'maxDocuments',
    MAX_MIGRATION_DOCUMENTS,
  );

  const startedAt = Date.now();

  let scanned = 0;
  let matched = 0;
  let updated = 0;
  let lastId: ObjectId | undefined;

  while (scanned < options.maxDocuments) {
    const remaining = options.maxDocuments - scanned;
    const limit = Math.min(options.batchSize, remaining);

    const documents = await collection
      .find(buildScanFilter(lastId), {
        projection: { _id: 1 },
      })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();

    if (documents.length === 0) {
      break;
    }

    scanned += documents.length;
    lastId = documents[documents.length - 1]._id;

    if (!options.execute) {
      continue;
    }

    const ids = documents.map((document) => document._id);

    const updateResult = await collection.updateMany(
      {
        _id: { $in: ids },
        refreshToken: { $exists: true },
      },
      {
        $unset: {
          refreshToken: '',
        },
      },
    );

    if (!updateResult.acknowledged) {
      throw new Error(
        'MongoDB không xác nhận batch cleanup refreshToken legacy',
      );
    }

    matched += updateResult.matchedCount;
    updated += updateResult.modifiedCount;
  }

  const hasMore = options.execute
    ? Boolean(
        await collection.findOne(legacyTokenFilter, {
          projection: { _id: 1 },
        }),
      )
    : lastId
      ? Boolean(
          await collection.findOne(buildScanFilter(lastId), {
            projection: { _id: 1 },
          }),
        )
      : false;

  return {
    execute: options.execute,
    scanned,
    planned: options.execute ? matched : scanned,
    matched,
    updated,
    hasMore,
    throughId: lastId?.toHexString() ?? null,
    durationMs: Date.now() - startedAt,
  };
}
