import { createConnection } from 'mongoose';
import {
  SponsoredPost,
  SponsoredPostSchema,
} from '../modules/sponsored-posts/sponsored-post.schema';
import { SponsoredSchedulerStore } from '../modules/sponsored-posts/sponsored-scheduler.store';

/** Explicit additive provisioning only: no Nest bootstrap, cron, TTL on campaigns, or index drops. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--execute' && !arg.startsWith('--database=')))
    throw new Error('ARGUMENT_INVALID');
  const databases = args.filter((arg) => arg.startsWith('--database='));
  const database = databases[0]?.slice('--database='.length);
  if (
    databases.length !== 1 ||
    !database ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(database)
  )
    throw new Error('DATABASE_INVALID');
  if (!args.includes('--execute')) {
    console.log(
      JSON.stringify({
        execute: false,
        database,
        operation:
          'add sponsored indexes and initialize scheduler control; no campaign mutations',
      }),
    );
    return;
  }
  if (
    process.env.SPONSORED_SCHEDULER_INDEX_CONFIRMATION !==
    'CREATE_SPONSORED_SCHEDULER_INDEXES'
  )
    throw new Error('CONFIRMATION_REQUIRED');
  const uri = process.env.SPONSORED_SCHEDULER_INDEX_URI?.trim();
  if (!uri) throw new Error('INDEX_URI_REQUIRED');
  const connection = await createConnection(uri, {
    dbName: database,
    autoIndex: false,
    serverSelectionTimeoutMS: 15000,
  }).asPromise();
  try {
    await connection
      .model(SponsoredPost.name, SponsoredPostSchema)
      .createIndexes();
    await new SponsoredSchedulerStore(connection).ensureIndexes();
    console.log(JSON.stringify({ success: true, execute: true, database }));
  } finally {
    await connection.close();
  }
}
if (require.main === module) {
  void main().catch(() => {
    console.error('SPONSORED_SCHEDULER_INDEX_PREPARATION_FAILED');
    process.exitCode = 1;
  });
}
