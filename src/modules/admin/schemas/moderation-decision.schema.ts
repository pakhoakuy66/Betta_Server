import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { MODERATION_REASON_TAXONOMY_VERSION } from '../../../common/moderation/moderation-reason.constants';
import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminReportDecision,
  AdminReportDecisionOutcome,
  AdminReportTargetAction,
} from '../constants/admin-report-decision.constants';
import { ReportTargetType } from '../../reports/schemas/report.schema';
import { generateModerationDecisionPublicId } from '../utils/generate-moderation-decision-public-id';

@Schema({ timestamps: true, collection: 'moderation_decisions' })
export class ModerationDecision extends Document {
  @Prop({
    type: String,
    required: true,
    unique: true,
    immutable: true,
    default: generateModerationDecisionPublicId,
  })
  publicId!: string;

  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  reportId!: Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  reportPublicId!: string;

  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  targetId!: Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  targetPublicId!: string;

  @Prop({
    type: String,
    enum: Object.values(ReportTargetType),
    required: true,
    immutable: true,
  })
  targetType!: ReportTargetType;

  @Prop({
    type: String,
    enum: Object.values(AdminReportDecision),
    required: true,
    immutable: true,
  })
  decision!: AdminReportDecision;

  @Prop({
    type: String,
    enum: Object.values(AdminReportTargetAction),
    required: true,
    immutable: true,
  })
  targetAction!: AdminReportTargetAction;

  @Prop({
    type: String,
    enum: Object.values(AdminReportDecisionOutcome),
    required: true,
    immutable: true,
  })
  outcome!: AdminReportDecisionOutcome;

  @Prop({ type: String, required: true, immutable: true })
  reasonCode!: string;

  @Prop({ type: String, default: null, immutable: true })
  actionReasonCode!: string | null;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    enum: [MODERATION_REASON_TAXONOMY_VERSION],
  })
  reasonTaxonomyVersion!: number;

  @Prop({ type: String, required: true, maxlength: 500, immutable: true })
  reasonNote!: string;

  @Prop({ type: String, required: true, immutable: true })
  actorPublicId!: string;

  @Prop({
    type: String,
    enum: Object.values(AdminRole),
    required: true,
    immutable: true,
  })
  actorRole!: AdminRole;

  @Prop({ type: Number, required: true, min: 0, immutable: true })
  reportBeforeVersion!: number;

  @Prop({ type: Number, required: true, min: 1, immutable: true })
  reportAfterVersion!: number;

  @Prop({ type: Number, default: null, min: 0, immutable: true })
  targetBeforeVersion!: number | null;

  @Prop({ type: Number, default: null, min: 0, immutable: true })
  targetAfterVersion!: number | null;

  @Prop({ type: Date, required: true, immutable: true })
  terminalAt!: Date;

  @Prop({ type: String, default: null, immutable: true })
  correlationId!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ModerationDecisionSchema =
  SchemaFactory.createForClass(ModerationDecision);

ModerationDecisionSchema.index(
  { reportPublicId: 1 },
  { unique: true, name: 'moderation_decision_report_unique_v1' },
);
ModerationDecisionSchema.index(
  { targetType: 1, targetPublicId: 1, terminalAt: -1, publicId: 1 },
  { name: 'moderation_decision_target_history_v1' },
);
ModerationDecisionSchema.index(
  { actorPublicId: 1, terminalAt: -1, publicId: 1 },
  { name: 'moderation_decision_actor_history_v1' },
);
