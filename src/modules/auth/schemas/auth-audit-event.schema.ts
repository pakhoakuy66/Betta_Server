import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  type HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditProvider,
  AuthAuditReasonCode,
} from '../interfaces/auth-audit.interface';

export const AUTH_AUDIT_COLLECTION = 'auth_audit_events';

export const AUTH_AUDIT_DEFAULT_RETENTION_DAYS = 180;

export const AUTH_AUDIT_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{16,60}$/;

@Schema({
  _id: false,
  strict: 'throw',
})
export class AuthAuditEventMetadata {
  @Prop({
    type: Number,
    min: 0,
    max: 10_000,
    immutable: true,
  })
  affectedSessionCount?: number;

  @Prop({
    type: String,
    enum: Object.values(AuthAuditProvider),
    immutable: true,
  })
  provider?: AuthAuditProvider;
}

const AuthAuditEventMetadataSchema = SchemaFactory.createForClass(
  AuthAuditEventMetadata,
);

@Schema({
  collection: AUTH_AUDIT_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: {
    createdAt: 'occurredAt',
    updatedAt: false,
  },
})
export class AuthAuditEvent {
  @Prop({
    type: String,
    enum: Object.values(AuthAuditEventCode),
    required: true,
    immutable: true,
  })
  eventCode!: AuthAuditEventCode;

  @Prop({
    type: String,
    enum: Object.values(AuthAuditOutcome),
    required: true,
    immutable: true,
  })
  outcome!: AuthAuditOutcome;

  @Prop({
    type: String,
    enum: Object.values(AuthAuditReasonCode),
    required: true,
    immutable: true,
  })
  reasonCode!: AuthAuditReasonCode;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  targetUserId!: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    default: null,
    immutable: true,
  })
  actorUserId!: Types.ObjectId | null;

  @Prop({
    type: String,
    trim: true,
    minlength: 20,
    maxlength: 64,
    match: AUTH_AUDIT_SESSION_ID_PATTERN,
    immutable: true,
  })
  sessionPublicId?: string;

  @Prop({
    type: AuthAuditEventMetadataSchema,
    default: undefined,
    immutable: true,
  })
  metadata?: AuthAuditEventMetadata;

  @Prop({
    type: Date,
    required: true,
    immutable: true,
  })
  expiresAt!: Date;

  occurredAt!: Date;
}

export type AuthAuditEventDocument = HydratedDocument<AuthAuditEvent>;

export const AuthAuditEventSchema =
  SchemaFactory.createForClass(AuthAuditEvent);

AuthAuditEventSchema.index(
  { expiresAt: 1 },
  {
    name: 'expiresAt_ttl',
    expireAfterSeconds: 0,
  },
);

AuthAuditEventSchema.index(
  {
    targetUserId: 1,
    occurredAt: -1,
  },
  {
    name: 'targetUserId_1_occurredAt_-1',
  },
);

AuthAuditEventSchema.index(
  {
    actorUserId: 1,
    occurredAt: -1,
  },
  {
    name: 'actorUserId_1_occurredAt_-1',
    partialFilterExpression: {
      actorUserId: {
        $type: 'objectId',
      },
    },
  },
);

AuthAuditEventSchema.index(
  {
    eventCode: 1,
    occurredAt: -1,
  },
  {
    name: 'eventCode_1_occurredAt_-1',
  },
);

AuthAuditEventSchema.index(
  {
    targetUserId: 1,
    eventCode: 1,
    occurredAt: -1,
  },
  {
    name: 'targetUserId_1_eventCode_1_occurredAt_-1',
  },
);

const rejectAuditMutation = (): never => {
  throw new Error('Auth audit events are append-only');
};

AuthAuditEventSchema.pre('save', function rejectDocumentUpdate() {
  if (!this.isNew) {
    rejectAuditMutation();
  }
});

AuthAuditEventSchema.pre(
  'deleteOne',
  {
    document: true,
    query: false,
  },
  function rejectDocumentDelete() {
    rejectAuditMutation();
  },
);

AuthAuditEventSchema.pre(
  'deleteOne',
  {
    document: false,
    query: true,
  },
  function rejectQueryDelete() {
    rejectAuditMutation();
  },
);

AuthAuditEventSchema.pre('deleteMany', function rejectDeleteMany() {
  rejectAuditMutation();
});

AuthAuditEventSchema.pre('updateOne', function rejectUpdateOne() {
  rejectAuditMutation();
});

AuthAuditEventSchema.pre('updateMany', function rejectUpdateMany() {
  rejectAuditMutation();
});

AuthAuditEventSchema.pre('replaceOne', function rejectReplaceOne() {
  rejectAuditMutation();
});

AuthAuditEventSchema.pre('findOneAndUpdate', function rejectFindOneAndUpdate() {
  rejectAuditMutation();
});

AuthAuditEventSchema.pre(
  'findOneAndReplace',
  function rejectFindOneAndReplace() {
    rejectAuditMutation();
  },
);

AuthAuditEventSchema.pre('findOneAndDelete', function rejectFindOneAndDelete() {
  rejectAuditMutation();
});

AuthAuditEventSchema.pre('bulkWrite', function rejectBulkWrite() {
  rejectAuditMutation();
});
