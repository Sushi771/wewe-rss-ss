import { sqliteWrites } from './sqlite-write-coordinator';

/** Exclusive write ownership lasts through controlled connection cleanup.
 * Never replay the callback, or infer its commit result from its rejection. */
export function mediaTransaction<T>(
  prisma: { recoverFailedMediaTransaction(): Promise<void> },
  operation: () => Promise<T>,
): Promise<T> {
  return sqliteWrites.protectedWrite(
    async () => undefined,
    async () => {
      try {
        return await operation();
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (('code' in error && error.code === 'P2028') ||
            ('name' in error && error.name === 'PrismaClientRustPanicError'))
        )
          await prisma.recoverFailedMediaTransaction();
        throw error;
      }
    },
  );
}
