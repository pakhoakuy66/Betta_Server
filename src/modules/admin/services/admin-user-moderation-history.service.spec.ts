import { describe, expect, it } from '@jest/globals';
import { AdminModerationHistoryService } from './admin-moderation-history.service';
import { AdminUserModerationHistoryService } from './admin-user-moderation-history.service';

describe('AdminUserModerationHistoryService compatibility export', () => {
  it('resolves to the canonical ADM-MOD-09 service', () => {
    expect(AdminUserModerationHistoryService).toBe(
      AdminModerationHistoryService,
    );
  });
});
