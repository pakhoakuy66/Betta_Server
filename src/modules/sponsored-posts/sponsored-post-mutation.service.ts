import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { ADMIN_AUDIT_CORRELATION_ID_PATTERN } from '../admin/constants/admin-audit.constants';
import { Connection, Model } from 'mongoose';
import { AdminPermission as Permission } from '../admin/constants/admin-permission.constants';
import type { AdminRequestPrincipal } from '../admin/types/admin-authenticated-request';
import { SponsoredPostWriterService } from './sponsored-post-writer.service';
import { SponsoredTransition } from './sponsored-post.constants';
import {
  SponsoredMutationReceipt,
  type SponsoredMutationResult,
} from './sponsored-mutation-receipt.schema';
import {
  CreateSponsoredPostDto,
  UpdateSponsoredPostDto,
  SponsoredVersionMutationDto,
} from './sponsored-post-mutation.dto';

type Operation = 'create' | 'update' | 'delete' | 'restore';
type Input =
  | CreateSponsoredPostDto
  | UpdateSponsoredPostDto
  | SponsoredVersionMutationDto;
const permissions: Record<Operation, Permission> = {
  create: Permission.SPONSORED_POSTS_CREATE,
  update: Permission.SPONSORED_POSTS_UPDATE,
  delete: Permission.SPONSORED_POSTS_DELETE,
  restore: Permission.SPONSORED_POSTS_RESTORE,
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const RECEIPT_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SponsoredPostMutationService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SponsoredMutationReceipt.name)
    private readonly receipts: Model<SponsoredMutationReceipt>,
    private readonly writer: SponsoredPostWriterService,
  ) {}

  async execute(
    actor: AdminRequestPrincipal,
    operation: Operation,
    target: string | null,
    input: Input,
    key: string,
  ): Promise<SponsoredMutationResult> {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new BadRequestException('SPONSORED_IDEMPOTENCY_KEY_INVALID');
    // Reuse Admin DTO correlation contract; never include transport context in fingerprint.
    const correlationId =
      input.correlationId === undefined
        ? 'corr_' + randomUUID()
        : typeof input.correlationId === 'string'
          ? input.correlationId.trim()
          : '';
    if (!ADMIN_AUDIT_CORRELATION_ID_PATTERN.test(correlationId))
      throw new BadRequestException('SPONSORED_CORRELATION_ID_INVALID');
    // Stable field order: different JSON key ordering must not defeat replay.
    const fields =
      operation === 'create' || operation === 'update'
        ? [
            'content',
            'cta',
            'destinationUrl',
            'startAt',
            'endAt',
            'reasonCode',
            ...(operation === 'update' ? ['expectedVersion'] : []),
          ]
        : ['expectedVersion', 'reasonCode'];
    const record = input as unknown as Record<string, unknown>;
    const fingerprint = hash(
      JSON.stringify([operation, target, fields.map((field) => record[field])]),
    );
    const keyHash = hash(key);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.connection.transaction(
          async (session) => {
            await this.writer.authorizeMutation(
              actor,
              permissions[operation],
              session,
            );
            const scope = { actorPublicId: actor.publicId, keyHash };
            const receipt = await this.receipts
              .findOne(scope)
              .session(session)
              .lean()
              .exec();
            if (receipt) {
              if (receipt.expiresAt.getTime() <= Date.now())
                throw new ConflictException(
                  'SPONSORED_IDEMPOTENCY_KEY_EXPIRED',
                );
              if (receipt.fingerprint !== fingerprint)
                throw new ConflictException('SPONSORED_IDEMPOTENCY_KEY_REUSED');
              if (!receipt.result)
                throw new ConflictException('SPONSORED_REQUEST_IN_PROGRESS');
              return receipt.result;
            }
            // Reserve before mutation. Reservation, campaign, audit and outbox share one commit.
            const [reservation] = await this.receipts.create(
              [
                {
                  ...scope,
                  fingerprint,
                  expiresAt: new Date(Date.now() + RECEIPT_MS),
                },
              ],
              { session },
            );
            const context = { reasonCode: input.reasonCode, correlationId };
            let result: SponsoredMutationResult;
            if (operation === 'create' || operation === 'update') {
              const body = input as CreateSponsoredPostDto;
              const content = {
                content: body.content,
                cta: body.cta,
                destinationUrl: body.destinationUrl,
                startAt: new Date(body.startAt),
                endAt: new Date(body.endAt),
              };
              result =
                operation === 'create'
                  ? await this.writer.createDraft(
                      actor,
                      { ...content, images: [] },
                      context,
                      session,
                    )
                  : await this.writer.updateDraft(
                      actor,
                      target!,
                      (input as UpdateSponsoredPostDto).expectedVersion,
                      content,
                      context,
                      session,
                    );
            } else {
              result = await this.writer.transition(
                actor,
                target!,
                (input as SponsoredVersionMutationDto).expectedVersion,
                operation === 'delete'
                  ? SponsoredTransition.DELETE
                  : SponsoredTransition.RESTORE,
                context,
                session,
              );
            }
            reservation.result = result;
            await reservation.save({ session });
            return result;
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
          },
        );
      } catch (error: unknown) {
        // Concurrent insert of the same unique receipt: retry against the winner's commit.
        if (
          attempt === 0 &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 11000
        )
          continue;
        throw error;
      }
    }
    throw new ConflictException('SPONSORED_REQUEST_IN_PROGRESS');
  }
}
