import { Schema } from 'mongoose';
import type { toPublicSponsoredPost } from './sponsored-post.mapper';

export type SponsoredMutationResult = ReturnType<typeof toPublicSponsoredPost>;
export class SponsoredMutationReceipt {
  actorPublicId!: string;
  keyHash!: string;
  fingerprint!: string;
  result!: SponsoredMutationResult | null;
  expiresAt!: Date;
}
// Stores only the allowlisted response, not raw request, token or idempotency key.
export const SponsoredMutationReceiptSchema =
  new Schema<SponsoredMutationReceipt>(
    {
      actorPublicId: { type: String, required: true },
      keyHash: { type: String, required: true },
      fingerprint: { type: String, required: true },
      result: { type: Schema.Types.Mixed, default: null },
      expiresAt: { type: Date, required: true },
    },
    {
      collection: 'sponsored_mutation_receipts',
      strict: 'throw',
      versionKey: false,
    },
  );
SponsoredMutationReceiptSchema.index(
  { actorPublicId: 1, keyHash: 1 },
  {
    unique: true,
    name: 'sponsored_mutation_actor_key_unique',
  },
);
SponsoredMutationReceiptSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'sponsored_mutation_receipt_ttl',
  },
);
