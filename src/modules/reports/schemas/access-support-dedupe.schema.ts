import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'access_support_dedupes' })
export class AccessSupportDedupe extends Document {
  @Prop({ type: String, required: true, select: false })
  fingerprintHmac!: string;

  @Prop({ type: String, required: true })
  reportPublicId!: string;

  @Prop({ type: Date, required: true })
  activeUntil!: Date;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;
}

export const AccessSupportDedupeSchema =
  SchemaFactory.createForClass(AccessSupportDedupe);

AccessSupportDedupeSchema.index(
  { fingerprintHmac: 1 },
  { unique: true, name: 'access_support_dedupe_fingerprint_unique' },
);
AccessSupportDedupeSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'access_support_dedupe_expiry_ttl' },
);
