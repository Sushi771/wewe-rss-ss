import { PrismaClient } from '@prisma/client';

/** Test-only. Keep the fixture path and other query parameters byte-for-byte. */
function migrationUrl(originalFixtureUrl: string): string {
  const queryAt = originalFixtureUrl.indexOf('?');
  if (
    !originalFixtureUrl.startsWith('file:') ||
    (queryAt === -1 ? originalFixtureUrl.length : queryAt) <= 5 ||
    originalFixtureUrl.includes('#')
  )
    throw new Error('Expected an explicit SQLite fixture URL');
  const parameters = new URLSearchParams(
    queryAt === -1 ? '' : originalFixtureUrl.slice(queryAt + 1),
  );
  const limits = parameters.getAll('connection_limit');
  if (limits.length > 1 || (limits.length === 1 && limits[0] !== '1'))
    throw new Error(
      'Fixture migration connection_limit must be unambiguous and 1',
    );
  if (limits.length === 1) return originalFixtureUrl;
  return (
    originalFixtureUrl +
    (queryAt === -1 ? '?' : originalFixtureUrl.endsWith('?') ? '' : '&') +
    'connection_limit=1'
  );
}

/**
 * Run native BEGIN/COMMIT migration statements on one dedicated connection.
 * The caller supplies its fixture URL and unchanged migration body explicitly.
 * Never pass or reconfigure the business client used by the assertions.
 */
export async function withFixtureMigrationConnection<T>(
  originalFixtureUrl: string,
  migrate: (migrationClient: PrismaClient) => Promise<T>,
): Promise<T> {
  const migrationClient = new PrismaClient({
    datasources: { db: { url: migrationUrl(originalFixtureUrl) } },
  });
  let migrationFailed = false;
  let migrationError: unknown;
  try {
    return await migrate(migrationClient);
  } catch (error) {
    migrationFailed = true;
    migrationError = error;
    throw error;
  } finally {
    try {
      await migrationClient.$disconnect();
    } catch (disconnectError) {
      if (migrationFailed)
        throw new AggregateError(
          [migrationError, disconnectError],
          'Fixture migration and disconnect both failed',
        );
      throw disconnectError;
    }
  }
}
