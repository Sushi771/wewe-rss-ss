import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';
import { dirname, isAbsolute, join } from 'node:path';
import type { XhsCreator } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedbookClient } from './redbook-client';
import {
  createRedbookHttpTransport,
  createRedbookMediaHttpTransport,
} from './redbook-http';
import { FileRedbookStateStore } from './redbook-scan-state';
import { redbookReader, RedbookSource } from './redbook-source';
import { redbookBindingSchema, reviewRedbookBinding } from './redbook-evidence';
import type {
  XhsSource,
  XhsReadResult,
  XhsRefreshResult,
} from './xiaohongshu.service';

const input = z
  .object({
    cookies: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      z
        .string()
        .min(1)
        .max(8192)
        .regex(/^[^;\s\x00-\x1f\x7f]+$/),
    ),
    expiresAt: z.number().int(),
    bindings: z.array(redbookBindingSchema).min(1).max(20),
  })
  .strict();
type Session = {
  cookies: Record<string, string>;
  expiresAt: number;
  bindings: ReturnType<typeof reviewRedbookBinding>[];
  abort: AbortController;
  source: RedbookSource;
  timer: ReturnType<typeof setTimeout>;
};

/** Runtime provider used by Nest. No env/browser credential loader and no network on install. */
@Injectable()
export class RedbookRuntime implements XhsSource, OnModuleDestroy {
  private session?: Session;
  private active = 0;
  private readonly activeCreators = new Map<string, number>();
  private changing = false;
  private epoch = 0;
  constructor(private readonly prisma: PrismaService) {}
  get configured() {
    return !!this.session && this.session.expiresAt > Date.now();
  }
  status() {
    return {
      configured: this.configured,
      expiresAt: this.configured ? this.session!.expiresAt : null,
      bindingCount: this.configured ? this.session!.bindings.length : 0,
      reviewBasis: this.configured ? 'operator-supplied-evidence' : null,
      platformVerified: false,
      liveValidation: 'pending',
    };
  }
  async install(raw: unknown) {
    if (this.active || this.changing) throw new Error('REDBOOK_SESSION_BUSY');
    this.changing = true;
    const epoch = this.epoch;
    try {
      const parsed = input.parse(raw);
      if (
        !parsed.cookies.a1 ||
        !parsed.cookies.web_session ||
        Object.keys(parsed.cookies).length > 100 ||
        parsed.expiresAt <= Date.now() ||
        parsed.expiresAt > Date.now() + 2 * 3600000
      )
        throw new Error('REDBOOK_SESSION_INVALID');
      const bindings = parsed.bindings.map(reviewRedbookBinding);
      if (
        new Set(bindings.map((b) => b.creatorId)).size !== bindings.length ||
        new Set(bindings.map((b) => b.authorId)).size !== bindings.length
      )
        throw new Error('REDBOOK_BINDING_DUPLICATE');
      for (const binding of bindings) {
        const creator = await this.prisma.xhsCreator.findUnique({
          where: { id: binding.creatorId },
        });
        if (
          !creator ||
          creator.profileUrl !== binding.profileUrl ||
          (creator.externalAuthorId &&
            creator.externalAuthorId !== binding.authorId)
        )
          throw new Error('REDBOOK_BINDING_CONFLICT');
        const other = await this.prisma.xhsCreator.findFirst({
          where: {
            externalAuthorId: binding.authorId,
            id: { not: binding.creatorId },
          },
          select: { id: true },
        });
        if (other) throw new Error('REDBOOK_BINDING_CONFLICT');
      }
      const database = process.env.DATABASE_URL?.startsWith('file:')
        ? process.env.DATABASE_URL.slice(5)
        : '';
      if (!database || !isAbsolute(database) || /[?\x00]/.test(database))
        throw new Error('REDBOOK_LOCAL_SQLITE_REQUIRED');
      if (epoch !== this.epoch) throw new Error('REDBOOK_HANDOFF_CANCELLED');
      await this.clearSession();
      if (epoch !== this.epoch || parsed.expiresAt <= Date.now())
        throw new Error('REDBOOK_HANDOFF_CANCELLED');
      const abort = new AbortController();
      const cookies = { ...parsed.cookies };
      const expiresAt = parsed.expiresAt;
      const client = new RedbookClient({
        transport: createRedbookHttpTransport(abort.signal),
        cookies: () => {
          if (abort.signal.aborted || Date.now() >= expiresAt)
            throw new Error('REDBOOK_SESSION_EXPIRED');
          return { ...cookies };
        },
      });
      const source = new RedbookSource({
        reader: redbookReader(client, (url, options) => {
          if (abort.signal.aborted || Date.now() >= expiresAt)
            throw new Error('REDBOOK_SESSION_EXPIRED');
          return createRedbookMediaHttpTransport(abort.signal)(url, options);
        }),
        store: new FileRedbookStateStore(
          join(dirname(database), '.redbook-state'),
        ),
        contractReviewed: true,
        authorFor: (creator) =>
          bindings.find(
            (b) =>
              b.creatorId === creator.id && b.profileUrl === creator.profileUrl,
          )?.authorId || null,
        isComplete: async (creatorId, noteId) =>
          !!(await this.prisma.xhsNote.findFirst({
            where: {
              creatorId,
              id: JSON.stringify(['xiaohongshu', 'note', noteId]),
              status: 'complete',
            },
          })),
      });
      const timer = setTimeout(() => {
        void this.revoke().catch(() => undefined);
      }, expiresAt - Date.now());
      timer.unref();
      this.session = { cookies, expiresAt, bindings, abort, source, timer };
      return this.status();
    } finally {
      this.changing = false;
    }
  }
  async revoke() {
    this.epoch++;
    await this.clearSession();
  }
  private async clearSession() {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    clearTimeout(session.timer);
    session.abort.abort();
    for (const key of Object.keys(session.cookies)) delete session.cookies[key];
    // Mark every active creator cancelled before awaiting any lock/checkpoint.
    // Idle bindings must not contend with another creator's scan lock.
    const pending = [...this.activeCreators.keys()].map((creatorId) => {
      const binding = session.bindings.find((b) => b.creatorId === creatorId)!;
      return session.source.pause({
        id: binding.creatorId,
        externalAuthorId: binding.authorId,
      } as XhsCreator);
    });
    if (
      (await Promise.allSettled(pending)).some(
        (result) => result.status === 'rejected',
      )
    )
      throw new Error('REDBOOK_PAUSE_CHECKPOINT_FAILED');
  }
  async read(): Promise<XhsReadResult> {
    throw new Error('REDBOOK_STREAM_REQUIRED');
  }
  async scan(
    creator: XhsCreator,
    commit: (result: XhsReadResult) => Promise<XhsRefreshResult>,
  ) {
    const session = this.session;
    if (
      !this.configured ||
      this.changing ||
      !session ||
      !session.bindings.some(
        (b) =>
          b.creatorId === creator.id &&
          b.profileUrl === creator.profileUrl &&
          (!creator.externalAuthorId ||
            creator.externalAuthorId === b.authorId),
      )
    )
      return {
        status: 'paused' as const,
        added: 0,
        message: '私有会话或可信作者绑定不可用，未请求来源。',
      };
    this.active++;
    this.activeCreators.set(
      creator.id,
      (this.activeCreators.get(creator.id) || 0) + 1,
    );
    try {
      return await session.source.scan(creator, commit);
    } finally {
      this.active--;
      const remaining = this.activeCreators.get(creator.id)! - 1;
      if (remaining) this.activeCreators.set(creator.id, remaining);
      else this.activeCreators.delete(creator.id);
    }
  }
  async pause(creator: XhsCreator) {
    await this.session?.source.pause(creator);
  }
  async resumeOperator(creatorId: string) {
    if (!this.configured || this.active || this.changing)
      throw new Error('REDBOOK_RESUME_BLOCKED');
    const binding = this.session!.bindings.find(
      (b) => b.creatorId === creatorId,
    );
    if (!binding) throw new Error('REDBOOK_RESUME_BLOCKED');
    await this.session!.source.resumeOperatorCheckpoint({
      id: creatorId,
      externalAuthorId: binding.authorId,
    } as XhsCreator);
  }
  async onModuleDestroy() {
    await this.revoke();
  }
}
