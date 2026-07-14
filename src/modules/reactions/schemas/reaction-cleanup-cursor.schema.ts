import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({
  timestamps: true,
  collection: 'reaction_cleanup_cursors',
})
export class ReactionCleanupCursor extends Document {
  @Prop({ type: String, required: true, trim: true })
  jobName!: string;

  @Prop({ type: Date, default: null })
  lastWeekStart!: Date | null;

  @Prop({ type: Types.ObjectId, default: null })
  lastRunId!: Types.ObjectId | null;
}

export const ReactionCleanupCursorSchema = SchemaFactory.createForClass(
  ReactionCleanupCursor,
);

ReactionCleanupCursorSchema.index({ jobName: 1 }, { unique: true });
