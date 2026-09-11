import { createConnection } from 'mongoose';
import { SponsoredDeliveryStore } from '../modules/sponsored-posts/sponsored-delivery.store';

async function main() {
  const args = process.argv.slice(2);
  const databaseArgs = args.filter((value) => value.startsWith('--database='));
  if (
    databaseArgs.length !== 1 ||
    args.some(
      (value) => value !== '--execute' && !value.startsWith('--database='),
    )
  )
    throw new Error('Invalid arguments');
  const database = databaseArgs[0].slice('--database='.length);
  if (
    !/^[A-Za-z0-9_-]{1,38}$/.test(database) ||
    ['admin', 'local', 'config'].includes(database)
  )
    throw new Error('Invalid database name');
  if (!args.includes('--execute')) {
    console.log(
      JSON.stringify({
        execute: false,
        database,
        operation: 'Add delivery session, receipt and checkpoint indexes only',
      }),
    );
    return;
  }
  if (
    process.env.SPONSORED_DELIVERY_INDEX_CONFIRMATION !==
    'PREPARE_SPONSORED_DELIVERY_INDEXES'
  )
    throw new Error('Confirmation required');
  const uri = process.env.SPONSORED_DELIVERY_INDEX_URI?.trim();
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
    throw new Error('URI required');
  const connection = await createConnection(uri, {
    dbName: database,
    autoIndex: false,
    serverSelectionTimeoutMS: 15000,
  }).asPromise();
  try {
    if (connection.name !== database) throw new Error('Database mismatch');
    await new SponsoredDeliveryStore(connection).prepareIndexes();
    console.log(JSON.stringify({ success: true, execute: true, database }));
  } finally {
    await connection.close();
  }
}
void main().catch(() => {
  // Never print MongoDB errors: their messages may contain a connection string.
  console.error('SPONSORED_DELIVERY_INDEX_PREPARATION_FAILED');
  process.exitCode = 1;
});
