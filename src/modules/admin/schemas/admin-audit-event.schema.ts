import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import {
  ADMIN_PERMISSION_CATALOG,
  type AdminPermission,
} from '../constants/admin-permission.constants';
import {
  ADMIN_AUDIT_CORRELATION_ID_PATTERN,
  ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
  ADMIN_AUDIT_PUBLIC_ID_PATTERN,
  ADMIN_AUDIT_REASON_CODE_PATTERN,
  ADMIN_AUDIT_SCHEMA_VERSION,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { generateAdminAuditPublicId } from '../utils/generate-admin-audit-public-id';

export const ADMIN_AUDIT_COLLECTION = 'admin_audit_events';
export const ADMIN_AUDIT_PUBLIC_ID_INDEX = 'admin_audit_public_id_unique';
export const ADMIN_AUDIT_RETENTION_INDEX = 'admin_audit_expires_at_ttl';
export const ADMIN_AUDIT_TIMELINE_INDEX = 'admin_audit_occurred_at_public_id';
export const ADMIN_AUDIT_ACTOR_INDEX =
  'admin_audit_actor_occurred_at_public_id';
export const ADMIN_AUDIT_ACTION_INDEX =
  'admin_audit_action_occurred_at_public_id';
export const ADMIN_AUDIT_TARGET_INDEX =
  'admin_audit_target_occurred_at_public_id';

const isNonNegativeInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0;

@Schema({ _id: false, strict: 'throw' })
export class AdminAuditActor {
  @Prop({
    type: String,
    enum: Object.values(AdminAuditActorType),
    required: true,
    immutable: true,
  })
  type!: AdminAuditActorType;

  @Prop({
    type: String,
    match: ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
    immutable: true,
  })
  publicId?: string;

  @Prop({ type: String, trim: true, maxlength: 40, immutable: true })
  username?: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 120,
    immutable: true,
  })
  displayName!: string;

  @Prop({ type: String, enum: AdminRole, immutable: true })
  role?: AdminRole;

  @Prop({
    type: String,
    enum: ADMIN_PERMISSION_CATALOG,
    immutable: true,
  })
  permission?: AdminPermission;

  @Prop({
    type: Number,
    min: 1,
    validate: { validator: isNonNegativeInteger },
    immutable: true,
  })
  permissionVersion?: number;
}

@Schema({ _id: false, strict: 'throw' })
export class AdminAuditTarget {
  @Prop({
    type: String,
    enum: Object.values(AdminAuditTargetType),
    required: true,
    immutable: true,
  })
  type!: AdminAuditTargetType;

  @Prop({
    type: String,
    required: true,
    match: ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
    immutable: true,
  })
  publicId!: string;

  @Prop({ type: String, trim: true, maxlength: 120, immutable: true })
  displayName?: string;
}

@Schema({ _id: false, strict: 'throw' })
export class AdminAuditMetadata {
  @Prop({
    type: Number,
    min: 0,
    validate: { validator: isNonNegativeInteger },
    immutable: true,
  })
  beforeVersion?: number;

  @Prop({
    type: Number,
    min: 0,
    validate: { validator: isNonNegativeInteger },
    immutable: true,
  })
  afterVersion?: number;

  @Prop({ type: String, trim: true, maxlength: 64, immutable: true })
  beforeState?: string;

  @Prop({ type: String, trim: true, maxlength: 64, immutable: true })
  afterState?: string;

  @Prop({
    type: Number,
    min: 0,
    max: 100_000,
    validate: { validator: isNonNegativeInteger },
    immutable: true,
  })
  affectedSessionCount?: number;

  @Prop({
    type: String,
    match: ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
    immutable: true,
  })
  beforeAssigneePublicId?: string;

  @Prop({
    type: String,
    match: ADMIN_AUDIT_ENTITY_PUBLIC_ID_PATTERN,
    immutable: true,
  })
  afterAssigneePublicId?: string;
}

const ActorSchema = SchemaFactory.createForClass(AdminAuditActor);
const TargetSchema = SchemaFactory.createForClass(AdminAuditTarget);
const MetadataSchema = SchemaFactory.createForClass(AdminAuditMetadata);

@Schema({
  collection: ADMIN_AUDIT_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: { createdAt: 'occurredAt', updatedAt: false },
})
export class AdminAuditEvent {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    default: generateAdminAuditPublicId,
    match: ADMIN_AUDIT_PUBLIC_ID_PATTERN,
  })
  publicId!: string;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    default: ADMIN_AUDIT_SCHEMA_VERSION,
    enum: [ADMIN_AUDIT_SCHEMA_VERSION],
  })
  schemaVersion!: typeof ADMIN_AUDIT_SCHEMA_VERSION;

  @Prop({
    type: String,
    enum: Object.values(AdminAuditAction),
    required: true,
    immutable: true,
  })
  action!: AdminAuditAction;

  @Prop({
    type: String,
    enum: Object.values(AdminAuditOutcome),
    required: true,
    immutable: true,
  })
  outcome!: AdminAuditOutcome;

  @Prop({ type: ActorSchema, required: true, immutable: true })
  actor!: AdminAuditActor;

  @Prop({ type: TargetSchema, required: true, immutable: true })
  target!: AdminAuditTarget;

  @Prop({
    type: String,
    required: true,
    match: ADMIN_AUDIT_REASON_CODE_PATTERN,
    immutable: true,
  })
  reasonCode!: string;

  @Prop({ type: String, trim: true, maxlength: 500, immutable: true })
  reasonNote?: string;

  @Prop({ type: MetadataSchema, default: undefined, immutable: true })
  metadata?: AdminAuditMetadata;

  @Prop({
    type: String,
    match: ADMIN_AUDIT_CORRELATION_ID_PATTERN,
    immutable: true,
  })
  correlationId?: string;

  @Prop({
    type: String,
    enum: Object.values(AdminAuditSource),
    required: true,
    immutable: true,
  })
  source!: AdminAuditSource;

  @Prop({ type: Date, required: true, immutable: true })
  expiresAt!: Date;

  occurredAt!: Date;
}

export type AdminAuditEventDocument = HydratedDocument<AdminAuditEvent>;
export const AdminAuditEventSchema =
  SchemaFactory.createForClass(AdminAuditEvent);

AdminAuditEventSchema.index(
  { publicId: 1 },
  { name: ADMIN_AUDIT_PUBLIC_ID_INDEX, unique: true },
);
AdminAuditEventSchema.index(
  { expiresAt: 1 },
  { name: ADMIN_AUDIT_RETENTION_INDEX, expireAfterSeconds: 0 },
);
AdminAuditEventSchema.index(
  { occurredAt: -1, publicId: 1 },
  { name: ADMIN_AUDIT_TIMELINE_INDEX },
);
AdminAuditEventSchema.index(
  { 'actor.publicId': 1, occurredAt: -1, publicId: 1 },
  { name: ADMIN_AUDIT_ACTOR_INDEX },
);
AdminAuditEventSchema.index(
  { action: 1, occurredAt: -1, publicId: 1 },
  { name: ADMIN_AUDIT_ACTION_INDEX },
);
AdminAuditEventSchema.index(
  { 'target.type': 1, 'target.publicId': 1, occurredAt: -1, publicId: 1 },
  { name: ADMIN_AUDIT_TARGET_INDEX },
);

const rejectMutation = (): never => {
  throw new Error('Admin audit events are append-only');
};

AdminAuditEventSchema.pre('save', function rejectDocumentUpdate() {
  if (!this.isNew) rejectMutation();
});
AdminAuditEventSchema.pre(
  'deleteOne',
  { document: true, query: false },
  rejectMutation,
);
AdminAuditEventSchema.pre(
  'deleteOne',
  { document: false, query: true },
  rejectMutation,
);
AdminAuditEventSchema.pre('deleteMany', rejectMutation);
AdminAuditEventSchema.pre('updateOne', rejectMutation);
AdminAuditEventSchema.pre('updateMany', rejectMutation);
AdminAuditEventSchema.pre('replaceOne', rejectMutation);
AdminAuditEventSchema.pre('findOneAndUpdate', rejectMutation);
AdminAuditEventSchema.pre('findOneAndReplace', rejectMutation);
AdminAuditEventSchema.pre('findOneAndDelete', rejectMutation);
AdminAuditEventSchema.pre('bulkWrite', rejectMutation);
