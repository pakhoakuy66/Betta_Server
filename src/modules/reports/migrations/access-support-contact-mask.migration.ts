import {
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  ObjectId,
} from 'mongodb';
import {
  SystemReportSource,
  SystemReportType,
} from '../schemas/system-report.schema';
import { AccessSupportCryptoService } from '../services/access-support-crypto.service';
import { maskAccessSupportContactEmail } from '../utils/mask-access-support-contact.util';

export const ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_DEFAULT_BATCH_SIZE = 250;
export const ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_MAX_BATCH_SIZE = 1_000;

export type AccessSupportContactMaskMigrationDocument = Document & {
  _id: ObjectId;
  publicId: string;
  encryptedContactEmail: string;
};

export type AccessSupportContactMaskMigrationOptions = Readonly<{
  execute: boolean;
  batchSize: number;
  afterId?: ObjectId;
}>;

export type AccessSupportContactMaskMigrationResult = Readonly<{
  execute: boolean;
  scanned: number;
  planned: number;
  updated: number;
  failed: number;
  hasMore: boolean;
  nextAfterId?: ObjectId;
}>;

type Collections = Readonly<{
  systemReports: Collection<AccessSupportContactMaskMigrationDocument>;
}>;

const missingMask = {
  $or: [
    { contactEmailMasked: null },
    { contactEmailMasked: { $exists: false } },
  ],
};

export const migrateAccessSupportContactMasks = async (
  collections: Collections,
  crypto: AccessSupportCryptoService,
  options: AccessSupportContactMaskMigrationOptions,
): Promise<AccessSupportContactMaskMigrationResult> => {
  if (
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > ACCESS_SUPPORT_CONTACT_MASK_MIGRATION_MAX_BATCH_SIZE
  ) {
    throw new TypeError('batchSize không hợp lệ');
  }

  const documents = await collections.systemReports
    .find(
      {
        source: SystemReportSource.AUTH_PUBLIC,
        reportType: SystemReportType.ACCOUNT_ACCESS,
        publicId: { $type: 'string' },
        encryptedContactEmail: { $type: 'string' },
        evidencePurgedAt: null,
        ...missingMask,
        ...(options.afterId ? { _id: { $gt: options.afterId } } : {}),
      },
      {
        projection: {
          _id: 1,
          publicId: 1,
          encryptedContactEmail: 1,
        },
      },
    )
    .sort({ _id: 1 })
    .limit(options.batchSize + 1)
    .toArray();
  const batch = documents.slice(0, options.batchSize);
  const operations: AnyBulkWriteOperation<AccessSupportContactMaskMigrationDocument>[] =
    [];
  let failed = 0;

  for (const document of batch) {
    try {
      const plaintext = crypto.decrypt(
        document.encryptedContactEmail,
        document.publicId,
        'contactEmail',
      );
      const contactEmailMasked = maskAccessSupportContactEmail(plaintext);
      operations.push({
        updateOne: {
          filter: {
            _id: document._id,
            publicId: document.publicId,
            encryptedContactEmail: document.encryptedContactEmail,
            evidencePurgedAt: null,
            ...missingMask,
          },
          update: { $set: { contactEmailMasked } },
        },
      });
    } catch {
      // Không log ciphertext, contact hoặc key id; record lỗi được giữ nguyên để review.
      failed += 1;
    }
  }

  let updated = 0;
  if (options.execute && operations.length > 0) {
    const result = await collections.systemReports.bulkWrite(operations, {
      ordered: false,
    });
    updated = result.modifiedCount;
  }

  const hasMore = documents.length > options.batchSize;
  const lastScanned = batch.at(-1)?._id;
  return Object.freeze({
    execute: options.execute,
    scanned: batch.length,
    planned: operations.length,
    updated,
    failed,
    hasMore,
    ...(hasMore && lastScanned ? { nextAfterId: lastScanned } : {}),
  });
};
