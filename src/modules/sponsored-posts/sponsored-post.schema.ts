import { Schema, type HydratedDocument } from 'mongoose';
import {
  generateSponsoredPublicId,
  SPONSORED_INDEXES,
  SPONSORED_POST_COLLECTION,
  SPONSORED_PUBLIC_ID_PATTERN,
  SponsoredAssetHealth,
  SponsoredPostStatus,
} from './sponsored-post.constants';
import {
  normalizeSponsoredDraft,
  type SponsoredDraftInput,
  type SponsoredImage,
} from './sponsored-post.policy';
import { ADMIN_PUBLIC_ID_PATTERN } from '../admin/utils/generate-admin-public-id';

export class SponsoredPost {
  publicId!: string;
  ownerPublicId!: string;
  content!: string;
  images!: SponsoredImage[];
  destinationUrl!: string;
  cta!: string;
  startAt!: Date;
  endAt!: Date;
  status!: SponsoredPostStatus;
  assetHealth!: SponsoredAssetHealth;
  assetHealthCheckedAt!: Date | null;
  statusReason!: string;
  deletedAt!: Date | null;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export type SponsoredPostDocument = HydratedDocument<SponsoredPost>;
// Internal capability, never an HTTP input. All domain writes also require a transaction.
export const SPONSORED_WRITE = Symbol('SPONSORED_WRITE');
const imageSchema = new Schema<SponsoredImage>(
  {
    url: { type: String, required: true, maxlength: 2048 },
    publicId: { type: String, required: true, maxlength: 255 },
  },
  { _id: false, versionKey: false, strict: 'throw' },
);

export const SponsoredPostSchema = new Schema<SponsoredPost>(
  {
    publicId: {
      type: String,
      required: true,
      immutable: true,
      default: generateSponsoredPublicId,
      match: SPONSORED_PUBLIC_ID_PATTERN,
    },
    ownerPublicId: {
      type: String,
      required: true,
      immutable: true,
      match: ADMIN_PUBLIC_ID_PATTERN,
      select: false,
    },
    content: { type: String, required: false, default: '', maxlength: 2500 },
    images: {
      type: [imageSchema],
      default: [],
      validate: (value: unknown[]) => Array.isArray(value) && value.length <= 3,
    },
    destinationUrl: { type: String, required: true, maxlength: 2048 },
    cta: { type: String, required: true, maxlength: 80 },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: {
      type: String,
      enum: Object.values(SponsoredPostStatus),
      required: true,
      default: SponsoredPostStatus.DRAFT,
    },
    assetHealth: {
      type: String,
      enum: Object.values(SponsoredAssetHealth),
      required: true,
      default: SponsoredAssetHealth.UNKNOWN,
      select: false,
    },
    statusReason: {
      type: String,
      required: true,
      default: 'campaign_created',
      match: /^[a-z][a-z0-9_.-]{2,63}$/,
      select: false,
    },
    deletedAt: { type: Date, default: null },
    assetHealthCheckedAt: { type: Date, default: null, select: false },
    version: {
      type: Number,
      default: 0,
      min: 0,
      max: 100000,
      validate: Number.isSafeInteger,
    },
  },
  {
    collection: SPONSORED_POST_COLLECTION,
    strict: 'throw',
    timestamps: true,
    versionKey: 'version',
    optimisticConcurrency: true,
  },
);

SponsoredPostSchema.pre('validate', function () {
  const draft: SponsoredDraftInput = {
    content: this.content,
    images: this.images.map(({ url, publicId }) => ({ url, publicId })),
    destinationUrl: this.destinationUrl,
    cta: this.cta,
    startAt: this.startAt,
    endAt: this.endAt,
  };
  normalizeSponsoredDraft(draft);
  if (
    (this.status === SponsoredPostStatus.DELETED) !==
    (this.deletedAt !== null)
  ) {
    throw new Error('SPONSORED_STATE_INCONSISTENT');
  }
});
SponsoredPostSchema.pre('save', function () {
  if (
    this.$locals.sponsoredWrite !== SPONSORED_WRITE ||
    !this.$session()?.inTransaction()
  ) {
    throw new Error('SPONSORED_AUDITED_WRITER_REQUIRED');
  }
});
// Query updates skip cross-field validation/CAS/audit. Use the domain writer instead.
const denyDirectWrite = (): never => {
  throw new Error('SPONSORED_AUDITED_WRITER_REQUIRED');
};
SponsoredPostSchema.pre(
  'updateOne',
  { document: false, query: true },
  denyDirectWrite,
);
SponsoredPostSchema.pre('updateMany', denyDirectWrite);
SponsoredPostSchema.pre('findOneAndUpdate', denyDirectWrite);
SponsoredPostSchema.pre('replaceOne', denyDirectWrite);
SponsoredPostSchema.pre('findOneAndReplace', denyDirectWrite);
SponsoredPostSchema.pre(
  'deleteOne',
  { document: true, query: true },
  denyDirectWrite,
);
SponsoredPostSchema.pre('deleteMany', denyDirectWrite);
SponsoredPostSchema.pre('findOneAndDelete', denyDirectWrite);
SponsoredPostSchema.pre('insertMany', denyDirectWrite);
SponsoredPostSchema.pre('bulkWrite', denyDirectWrite);

SponsoredPostSchema.index(
  { publicId: 1 },
  { unique: true, name: SPONSORED_INDEXES.publicId },
);
SponsoredPostSchema.index(
  { createdAt: -1, publicId: -1 },
  { name: SPONSORED_INDEXES.list },
);
SponsoredPostSchema.index(
  { status: 1, createdAt: -1, publicId: -1 },
  { name: SPONSORED_INDEXES.statusList },
);
SponsoredPostSchema.index(
  { status: 1, startAt: 1, publicId: 1 },
  { name: SPONSORED_INDEXES.start },
);
SponsoredPostSchema.index(
  { status: 1, endAt: 1, publicId: 1 },
  { name: SPONSORED_INDEXES.end },
);
SponsoredPostSchema.index(
  { status: 1, assetHealthCheckedAt: 1, publicId: 1 },
  { name: SPONSORED_INDEXES.health },
);
// Global schedule browsing complements the existing status-prefixed indexes.
SponsoredPostSchema.index(
  { startAt: 1, publicId: 1 },
  { name: SPONSORED_INDEXES.globalStart },
);
SponsoredPostSchema.index(
  { endAt: 1, publicId: 1 },
  { name: SPONSORED_INDEXES.globalEnd },
);
