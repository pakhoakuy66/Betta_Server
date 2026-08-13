import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Model, Types } from 'mongoose';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { ADMIN_LIFECYCLE_COORDINATOR_KEY } from '../constants/admin-lifecycle.constants';
import { AdminAccount } from '../schemas/admin-account.schema';
import { AdminLifecycleCoordinator } from '../schemas/admin-lifecycle-coordinator.schema';

@Injectable()
export class AdminLastSuperAdminInvariantService {
  constructor(
    @InjectModel(AdminAccount.name)
    private readonly accounts: Model<AdminAccount>,
    @InjectModel(AdminLifecycleCoordinator.name)
    private readonly coordinators: Model<AdminLifecycleCoordinator>,
  ) {}

  async prepareCoordinator(): Promise<void> {
    try {
      await this.coordinators.updateOne(
        { key: ADMIN_LIFECYCLE_COORDINATOR_KEY },
        {
          $setOnInsert: {
            key: ADMIN_LIFECYCLE_COORDINATOR_KEY,
            revision: 0,
          },
        },
        { upsert: true, runValidators: true },
      );
    } catch (error: unknown) {
      if (this.isDuplicateKey(error)) return;
      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Dịch vụ bảo vệ SuperAdmin cuối cùng tạm thời không khả dụng',
        );
      }
      throw error;
    }
  }

  async assertCanRemoveEffectiveAccess(
    targetAdminAccountId: Types.ObjectId,
    mongoSession: ClientSession,
  ): Promise<void> {
    if (
      !(targetAdminAccountId instanceof Types.ObjectId) ||
      !mongoSession.inTransaction()
    ) {
      throw new TypeError(
        'Last-SuperAdmin invariant yêu cầu target và transaction hợp lệ',
      );
    }

    const coordinator = await this.coordinators.updateOne(
      { key: ADMIN_LIFECYCLE_COORDINATOR_KEY },
      { $inc: { revision: 1 } },
      { session: mongoSession, runValidators: true },
    );
    if (coordinator.matchedCount !== 1) {
      throw new ServiceUnavailableException(
        'Không thể thiết lập khóa điều phối lifecycle Admin',
      );
    }

    const anotherEffectiveSuperAdmin = await this.accounts
      .exists({
        _id: { $ne: targetAdminAccountId },
        role: AdminRole.SUPER_ADMIN,
        status: AdminAccountStatus.ACTIVE,
        mfaStatus: AdminMfaStatus.ACTIVE,
        mustChangePassword: false,
        lockedAt: null,
        deletedAt: null,
      })
      .session(mongoSession);
    if (!anotherEffectiveSuperAdmin) {
      throw new ConflictException(
        'Không thể loại bỏ quyền hiệu lực của SuperAdmin cuối cùng',
      );
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      Number(error.code) === 11000
    );
  }
}
