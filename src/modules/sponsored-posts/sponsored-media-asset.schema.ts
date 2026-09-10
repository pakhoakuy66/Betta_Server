import { Schema } from 'mongoose';
export class SponsoredMediaAsset {
  publicId!: string;
  campaignPublicId!: string;
  remoteId!: string;
  url!: string;
  state!:
    | 'uploading'
    | 'ready'
    | 'attached'
    | 'deleting'
    | 'deleted'
    | 'manual_review';
  cleanupAfter!: Date;
  healthSequence!: number;
}
export const SponsoredMediaAssetSchema = new Schema<SponsoredMediaAsset>(
  {
    publicId: { type: String, required: true, immutable: true },
    campaignPublicId: { type: String, required: true, immutable: true },
    remoteId: { type: String, required: true, immutable: true },
    url: { type: String, default: '' },
    state: {
      type: String,
      enum: [
        'uploading',
        'ready',
        'attached',
        'deleting',
        'deleted',
        'manual_review',
      ],
      required: true,
    },
    cleanupAfter: { type: Date, required: true },
    healthSequence: { type: Number, default: 0 },
  },
  { collection: 'sponsored_media_assets', strict: 'throw', timestamps: true },
);
SponsoredMediaAssetSchema.index({ publicId: 1 }, { unique: true });
SponsoredMediaAssetSchema.index({ remoteId: 1 }, { unique: true });
SponsoredMediaAssetSchema.index({ campaignPublicId: 1, state: 1 });
