import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import {
  ADMIN_BOOTSTRAP_SECRET_ARGS_ENV,
  ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import { generateAdminActivationGrant } from '../utils/admin-activation-grant';
import { AdminBootstrapCommandSecretStore } from './admin-bootstrap-command-secret-store.service';

const writerScript = [
  "let body='';",
  "process.stdin.on('data', chunk => body += chunk);",
  "process.stdin.on('end', () => {",
  'const request = JSON.parse(body);',
  "if (request.operation === 'put-version') {",
  "process.stdout.write(JSON.stringify({reference:'sm://betta/admin-bootstrap/versions/1'}));",
  '} else { process.stdout.write(JSON.stringify({ok:true})); }',
  '});',
].join('');

const createStore = (args = ['-e', writerScript]) =>
  new AdminBootstrapCommandSecretStore(
    new ConfigService({
      [ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV]: process.execPath,
      [ADMIN_BOOTSTRAP_SECRET_ARGS_ENV]: JSON.stringify(args),
    }),
  );

describe('AdminBootstrapCommandSecretStore', () => {
  it('writes the grant through stdin and returns only a secret reference', async () => {
    const store = createStore();
    const rawGrant = generateAdminActivationGrant();
    await expect(
      store.putVersion({
        secretName: 'betta/admin/bootstrap',
        rawGrant,
        expiresAt: new Date(Date.now() + 900_000),
        context: {
          purpose: AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN,
          targetPublicId: 'adm_23456789ABCD',
          environment: AdminBootstrapEnvironment.TEST,
        },
      }),
    ).resolves.toBe('sm://betta/admin-bootstrap/versions/1');
  });

  it('accepts the approved normal Admin activation purpose', async () => {
    const rawGrant = generateAdminActivationGrant();

    await expect(
      createStore().putVersion({
        secretName: 'betta/admin/account-activation/adm_23456789abcd',
        rawGrant,
        expiresAt: new Date(Date.now() + 900_000),
        context: {
          purpose: AdminActivationGrantPurpose.ADMIN_ACCOUNT_ACTIVATION,
          targetPublicId: 'adm_23456789ABCD',
          environment: AdminBootstrapEnvironment.TEST,
        },
      }),
    ).resolves.toBe('sm://betta/admin-bootstrap/versions/1');
  });

  it('revokes a version without exposing provider output', async () => {
    await expect(
      createStore().revokeVersion('sm://betta/admin-bootstrap/versions/1'),
    ).resolves.toBeUndefined();
  });

  it('fails closed for missing or malformed configuration', () => {
    expect(() =>
      new AdminBootstrapCommandSecretStore(new ConfigService()).assertReady(),
    ).toThrow(ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV);
    expect(() => createStore([]).assertReady()).not.toThrow();
    expect(() =>
      new AdminBootstrapCommandSecretStore(
        new ConfigService({
          [ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV]: process.execPath,
          [ADMIN_BOOTSTRAP_SECRET_ARGS_ENV]: '{',
        }),
      ).assertReady(),
    ).toThrow(ADMIN_BOOTSTRAP_SECRET_ARGS_ENV);
  });

  it('sanitizes command failures and never includes the raw grant', async () => {
    const rawGrant = generateAdminActivationGrant();
    const failingScript =
      "process.stdin.resume();process.stderr.write('provider secret');process.exit(9)";
    const operation = createStore(['-e', failingScript]).putVersion({
      secretName: 'betta/admin/bootstrap',
      rawGrant,
      expiresAt: new Date(Date.now() + 900_000),
      context: {
        purpose: AdminActivationGrantPurpose.BOOTSTRAP_SUPER_ADMIN,
        targetPublicId: 'adm_23456789ABCD',
        environment: AdminBootstrapEnvironment.TEST,
      },
    });

    await expect(operation).rejects.toThrow(
      'Không thể ghi activation grant vào Secret Manager',
    );
    await expect(operation).rejects.not.toThrow(rawGrant);
  });
});
