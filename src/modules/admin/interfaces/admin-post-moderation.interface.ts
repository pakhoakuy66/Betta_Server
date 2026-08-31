import type { ClientSession, Types } from 'mongoose';
import type { CanonicalModerationReasonCode } from '../../../common/moderation/moderation-reason.constants';
import type { PostModerationState } from '../../posts/schemas/post.schema';
import type { AdminReportDecisionActor } from './admin-report-decision.interface';
import type { AdminPostModerationOperation } from '../constants/admin-post-moderation.constants';
import type { AdminPostModerationFailureStep } from '../constants/admin-post-moderation.constants';

export type AdminPostModerationActor = AdminReportDecisionActor;

export type AdminPostModerationTransitionInput = Readonly<{
  actorPublicId: string;
  operation: AdminPostModerationOperation;
  expectedModerationVersion: number;
  reasonCode: CanonicalModerationReasonCode;
  reasonNote?: string;
  correlationId?: string;
  postPublicId?: string;
  postId?: Types.ObjectId;
}>;

export type AdminPostModerationTransition = Readonly<{
  postId: Types.ObjectId;
  postPublicId: string;
  authorId: Types.ObjectId;
  beforeState: PostModerationState;
  afterState: PostModerationState;
  beforeVersion: number;
  afterVersion: number;
  moderatedAt: Date;
  publicReasonCode: string;
  publicMessage: string;
}>;

export type UpdateAdminPostModerationInput = Readonly<{
  actor: AdminPostModerationActor;
  postPublicId: string;
  operation: AdminPostModerationOperation;
  expectedModerationVersion: number;
  reasonCode: string;
  reasonNote?: string;
  correlationId?: string;
  idempotencyKey: string;
}>;

export type AdminPostModerationMutationResult = Readonly<{
  post: Readonly<{
    id: string;
    publicId: string;
    state: PostModerationState;
    moderationVersion: number;
    moderatedAt: string;
    cleanupRequested: boolean;
  }>;
}>;

export type EnqueueAdminPostTransitionInput = Readonly<{
  transition: AdminPostModerationTransition;
  operation: AdminPostModerationOperation;
  correlationId?: string;
  mongoSession: ClientSession;
}>;

export interface AdminPostModerationFailureInjector {
  hit(step: AdminPostModerationFailureStep): void | Promise<void>;
}
