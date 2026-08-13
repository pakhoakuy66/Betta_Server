import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import {
  ADMIN_BOOTSTRAP_SECRET_ARGS_ENV,
  ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV,
} from '../constants/admin-bootstrap.constants';
import { AdminRecoveryPurpose } from '../constants/admin-account-recovery.constants';
import { generateAdminSecurityGrant } from '../utils/admin-security-grant';
import { AdminRecoveryCommandSecretStore } from './admin-recovery-command-secret-store.service';

const writerScript = [
  "let body='';",
  "process.stdin.on('data', chunk => body += chunk);",
  "process.stdin.on('end', () => {",
  'const request = JSON.parse(body);',
  "if (request.operation === 'put-version') {",
  "process.stdout.write(JSON.stringify({reference:'sm://betta/admin-recovery/versions/1'}));",
  '} else { process.stdout.write(JSON.stringify({ok:true})); }',
  '});',
].join('');

const createStore = (args = ['-e', writerScript]) =>
  new AdminRecoveryCommandSecretStore(
    new ConfigService({
      [ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV]: process.execPath,
      [ADMIN_BOOTSTRAP_SECRET_ARGS_ENV]: JSON.stringify(args),
    }),
  );

describe('AdminRecoveryCommandSecretStore', () => {
  const input = () => ({
    secretName: 'betta/admin/recovery/test/adm_23456789abcd',
    rawGrant: generateAdminSecurityGrant(),
    expiresAt: new Date(Date.now() + 900_000),
    purpose: AdminRecoveryPurpose.ADMIN_MFA_RESET,
    targetPublicId: 'adm_23456789ABCD',
  });

  it('writes the raw grant only through stdin and returns a reference', async () => {
    const request = input();
    const result = await createStore().putVersion(request);
    expect(result).toBe('sm://betta/admin-recovery/versions/1');
    expect(result).not.toContain(request.rawGrant);
  });

  it('revokes a version without exposing provider output', async () => {
    await expect(
      createStore().revokeVersion('sm://betta/admin-recovery/versions/1'),
    ).resolves.toBeUndefined();
  });

  it('fails closed for missing or malformed command configuration', () => {
    expect(() =>
      new AdminRecoveryCommandSecretStore(new ConfigService()).assertReady(),
    ).toThrow(ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV);
    expect(() =>
      new AdminRecoveryCommandSecretStore(
        new ConfigService({
          [ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV]: process.execPath,
          [ADMIN_BOOTSTRAP_SECRET_ARGS_ENV]: '{',
        }),
      ).assertReady(),
    ).toThrow(ADMIN_BOOTSTRAP_SECRET_ARGS_ENV);
  });

  it('sanitizes provider failures and never leaks the raw grant', async () => {
    const request = input();
    const failingScript =
      "process.stdin.resume();process.stderr.write('provider-secret');process.exit(9)";
    const operation = createStore(['-e', failingScript]).putVersion(request);
    await expect(operation).rejects.toThrow(
      'Không thể ghi recovery grant vào Secret Manager',
    );
    await expect(operation).rejects.not.toThrow(request.rawGrant);
  });
});
