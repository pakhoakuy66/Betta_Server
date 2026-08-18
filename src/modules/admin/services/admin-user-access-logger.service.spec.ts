import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AdminUserAccessLogger } from './admin-user-access-logger.service';

describe('AdminUserAccessLogger', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs only safe list access metadata', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const service = new AdminUserAccessLogger();

    service.logList({ actorPublicId: 'adm_23456789ABCD', resultCount: 20 });

    const serialized = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(serialized)).toEqual({
      eventCode: 'ADMIN_USER_LIST_ACCESSED',
      operation: 'LIST_USERS',
      actorPublicId: 'adm_23456789ABCD',
      resultCount: 20,
    });
    expect(serialized).not.toMatch(/search|email|phone|authorization|cookie/iu);
  });

  it('logs actor and target public IDs without response data', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const service = new AdminUserAccessLogger();

    service.logDetail({
      actorPublicId: 'adm_23456789ABCD',
      targetPublicId: 'usr_23456789AB',
    });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      eventCode: 'ADMIN_USER_DETAIL_ACCESSED',
      operation: 'VIEW_USER_DETAIL',
      actorPublicId: 'adm_23456789ABCD',
      targetPublicId: 'usr_23456789AB',
    });
  });
});
