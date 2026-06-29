import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ versionKey: false })
export class AuthRateLimit extends Document {
  @Prop({ required: true, unique: true, index: true })
  keyHash!: string;

  @Prop({ required: true, default: 0 })
  count!: number;

  @Prop({ required: true })
  expiresAt!: Date;
}

export const AuthRateLimitSchema = SchemaFactory.createForClass(AuthRateLimit);

AuthRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
