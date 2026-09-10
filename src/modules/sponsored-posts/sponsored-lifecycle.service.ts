import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { randomUUID } from 'crypto';
import { AdminPermission as Permission } from '../admin/constants/admin-permission.constants';
import type { AdminRequestPrincipal } from '../admin/types/admin-authenticated-request';
import { SponsoredTransition as Action } from './sponsored-post.constants';
import { SponsoredPostWriterService } from './sponsored-post-writer.service';
import { SponsoredVersionMutationDto } from './sponsored-post-mutation.dto';
import { SponsoredActivationService } from './sponsored-activation.service';
import { SponsoredSchedulerStore } from './sponsored-scheduler.store';

@Injectable()
export class SponsoredLifecycleService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly writer: SponsoredPostWriterService,
    private readonly activation: SponsoredActivationService,
    private readonly store: SponsoredSchedulerStore,
  ) {}
  async execute(
    actor: AdminRequestPrincipal,
    publicId: string,
    action: Action,
    body: SponsoredVersionMutationDto,
  ) {
    if (
      ![
        Action.SCHEDULE,
        Action.ACTIVATE,
        Action.PAUSE,
        Action.RESUME,
        Action.RETURN_TO_DRAFT,
      ].includes(action)
    )
      throw new ForbiddenException('SPONSORED_OPERATION_NOT_ALLOWED');
    const permission = [Action.PAUSE, Action.RESUME].includes(action)
      ? Permission.SPONSORED_POSTS_PAUSE
      : Permission.SPONSORED_POSTS_SCHEDULE;
    await this.connection.transaction((session) =>
      this.writer.authorizeMutation(actor, permission, session),
    );
    await this.store.initialize();
    const proof = [Action.SCHEDULE, Action.ACTIVATE, Action.RESUME].includes(
      action,
    )
      ? await this.activation.probe(publicId, body.expectedVersion)
      : undefined;
    return this.connection.transaction(async (session) => {
      const now = await this.store.now(session);
      const execution = this.activation.execution(proof, now);
      const prepare = execution.prepare;
      return this.writer.transition(
        actor,
        publicId,
        body.expectedVersion,
        action,
        {
          reasonCode: body.reasonCode,
          correlationId: body.correlationId ?? `corr_${randomUUID()}`,
        },
        session,
        {
          now,
          prepare: async (post, activeSession) => {
            if (
              action === Action.PAUSE &&
              post.endAt.getTime() <= now.getTime()
            )
              throw new ConflictException('SPONSORED_SCHEDULE_ENDED');
            if (prepare) await prepare(post, activeSession);
          },
        },
      );
    });
  }
}
