import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { createAdminSecrets } from '../modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../modules/admin/config/auth-secret-material-boundary.config';

const configService = new ConfigService();
const source = {
  get: (key: string): unknown => configService.get(key),
};

try {
  const forbiddenMaterialBoundary = createAuthSecretMaterialBoundary(source);

  createAdminSecrets({
    source,
    forbiddenMaterialBoundary,
  });

  process.stdout.write('Admin secret configuration is valid.\n');
} catch (error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : 'Admin secret configuration is invalid.';

  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
