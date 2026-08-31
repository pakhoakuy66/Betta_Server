import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  AdminReportDecision,
  AdminReportDecisionOutcome,
  AdminReportDecisionRequestState,
  AdminReportTargetAction,
} from '../constants/admin-report-decision.constants';

@Schema({
  timestamps: true,
  collection: 'admin_report_decision_requests',
})
export class AdminReportDecisionRequest extends Document {
  @Prop({ type: String, required: true, select: false })
  idempotencyHash!: string;

  @Prop({ type: String, required: true, select: false })
  requestFingerprint!: string;

  @Prop({ type: String, required: true })
  actorPublicId!: string;

  @Prop({ type: String, required: true })
  actorSessionPublicId!: string;

  @Prop({ type: String, required: true })
  reportPublicId!: string;

  @Prop({
    type: String,
    enum: Object.values(AdminReportDecision),
    required: true,
  })
  decision!: AdminReportDecision;

  @Prop({
    type: String,
    enum: Object.values(AdminReportTargetAction),
    required: true,
  })
  targetAction!: AdminReportTargetAction;

  @Prop({
    type: String,
    enum: Object.values(AdminReportDecisionRequestState),
    required: true,
  })
  state!: AdminReportDecisionRequestState;

  @Prop({ type: String, default: null })
  resultDecisionPublicId!: string | null;

  @Prop({ type: String, default: null, enum: ['RESOLVED', 'REJECTED'] })
  resultStatus!: 'RESOLVED' | 'REJECTED' | null;

  @Prop({
    type: String,
    default: null,
    enum: Object.values(AdminReportDecisionOutcome),
  })
  resultOutcome!: AdminReportDecisionOutcome | null;

  @Prop({ type: Number, default: null, min: 1 })
  resultReportVersion!: number | null;

  @Prop({ type: Number, default: null, min: 0 })
  resultTargetVersion!: number | null;

  @Prop({ type: Date, default: null })
  resultTerminalAt!: Date | null;

  @Prop({ type: Date, required: true })
  idempotencyExpiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AdminReportDecisionRequestSchema = SchemaFactory.createForClass(
  AdminReportDecisionRequest,
);

AdminReportDecisionRequestSchema.index(
  { idempotencyHash: 1 },
  {
    unique: true,
    name: 'admin_report_decision_idempotency_unique_v1',
  },
);
AdminReportDecisionRequestSchema.index(
  { idempotencyExpiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'admin_report_decision_idempotency_expiry_ttl_v1',
  },
);
