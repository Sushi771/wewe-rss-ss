import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

/** Shared SQLite intent. Missing migration, database errors and unresolved
 * requests all close the lane. No automatic reset is provided. */
export class Wechat2RssSourceGate {
  constructor(
    private readonly db: PrismaClient,
    private readonly verify: () => boolean = () => true,
  ) {}

  async begin(): Promise<string> {
    const token = randomUUID();
    try {
      if (!this.verify()) throw new Error('database configuration changed');
      const changed = await this.db
        .$executeRaw`UPDATE Wechat2RssSourceGate SET state = 'pending', token = ${token}, status = NULL WHERE id = 1 AND state = 'idle'`;
      if (changed !== 1) throw new Error('closed');
      return token;
    } catch {
      throw new Error('WECHAT2RSS_SOURCE_STOPPED');
    }
  }

  async finish(token: string, status: 200 | 401 | 403 | 429): Promise<void> {
    try {
      if (!this.verify()) throw new Error('database configuration changed');
      const changed =
        status === 200
          ? await this.db
              .$executeRaw`UPDATE Wechat2RssSourceGate SET state = 'idle', token = NULL, status = NULL WHERE id = 1 AND state = 'pending' AND token = ${token}`
          : await this.db
              .$executeRaw`UPDATE Wechat2RssSourceGate SET state = 'stopped', status = ${status} WHERE id = 1 AND state = 'pending' AND token = ${token}`;
      if (changed !== 1) throw new Error('changed');
    } catch {
      throw new Error('WECHAT2RSS_SOURCE_STOP_PERSIST_FAILED');
    }
  }
}

let defaultGate: Wechat2RssSourceGate | undefined;
export function defaultWechat2RssSourceGate(): Wechat2RssSourceGate {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith('file:')) throw new Error('WECHAT2RSS_SOURCE_STOPPED');
  return (defaultGate ??= new Wechat2RssSourceGate(
    new PrismaClient({ datasources: { db: { url } } }),
    () => process.env.DATABASE_URL === url,
  ));
}
