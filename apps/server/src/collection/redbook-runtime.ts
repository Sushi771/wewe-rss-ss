import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { XhsCreator } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedbookClient, RedbookPauseError } from './redbook-client';
import {
  createRedbookHttpTransport,
  createRedbookMediaHttpTransport,
} from './redbook-http';
import { FileRedbookStateStore, freshRedbookState } from './redbook-scan-state';
import {
  redbookReader,
  RedbookSource,
  REDBOOK_QUEUE_SCOPE,
} from './redbook-source';
import {
  inspectRedbookDetail,
  mapRedbookPage,
  REDBOOK_RESPONSE_CONTRACT,
} from './redbook-response';
import { decodeInlineImage } from './image-fetch';
import {
  DiagnosticSession,
  diagnosticConfirm,
  diagnosticDetailInput,
  diagnosticImageInput,
  diagnosticReviewInput,
  diagnosticPreview,
  diagnosticSummary,
} from './redbook-diagnostic';
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
  private diagnostic?: DiagnosticSession;
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
    if (this.active || this.changing || this.diagnostic)
      throw new Error('REDBOOK_SESSION_BUSY');
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
    await Promise.all([this.clearSession(), this.clearDiagnostic()]);
  }
  private async clearDiagnostic() {
    const diagnostic = this.diagnostic;
    this.diagnostic = undefined;
    if (!diagnostic) return;
    clearTimeout(diagnostic.timer);
    diagnostic.abort.abort();
    for (const key of Object.keys(diagnostic.cookies))
      delete diagnostic.cookies[key];
    await diagnostic.flight;
    diagnostic.list = undefined;
    diagnostic.detail = undefined;
    diagnostic.notes = [];
    diagnostic.images = [];
  }
  diagnosticStatus() {
    if (this.diagnostic && Date.now() >= this.diagnostic.expiresAt)
      void this.clearDiagnostic().catch(() => undefined);
    return diagnosticSummary(this.diagnostic);
  }
  async startDiagnostic(raw: unknown) {
    if (this.active || this.changing || this.diagnostic || this.configured)
      throw new Error('REDBOOK_SESSION_BUSY');
    const schema = input
      .pick({ cookies: true, expiresAt: true })
      .extend({
        creatorId: z.string().min(1).max(128),
        confirmLocalSession: z.literal(true),
      })
      .strict();
    const parsed = schema.parse(raw);
    if (
      !parsed.cookies.a1 ||
      !parsed.cookies.web_session ||
      Object.keys(parsed.cookies).length > 100 ||
      parsed.expiresAt <= Date.now() ||
      parsed.expiresAt > Date.now() + 24 * 3600000
    )
      throw new Error('REDBOOK_SESSION_INVALID');
    this.changing = true;
    const epoch = this.epoch;
    try {
      const creator = await this.prisma.xhsCreator.findUnique({
        where: { id: parsed.creatorId },
      });
      const author =
        creator &&
        /^https:\/\/www\.xiaohongshu\.com\/user\/profile\/([a-zA-Z0-9_-]{1,128})$/.exec(
          creator.profileUrl,
        )?.[1];
      if (
        !creator ||
        !author ||
        (creator.externalAuthorId && creator.externalAuthorId !== author)
      )
        throw new Error('REDBOOK_DIAGNOSTIC_PROFILE');
      const database = process.env.DATABASE_URL?.startsWith('file:')
        ? process.env.DATABASE_URL.slice(5)
        : '';
      if (!database || !isAbsolute(database) || /[?\x00]/.test(database))
        throw new Error('REDBOOK_LOCAL_SQLITE_REQUIRED');
      const store = new FileRedbookStateStore(
        join(dirname(database), '.redbook-state'),
      );
      await store.exclusive(REDBOOK_QUEUE_SCOPE, async (state) => {
        if (state && state.phase !== 'ready')
          throw new Error('REDBOOK_SOURCE_PAUSED');
      });
      if (epoch !== this.epoch || parsed.expiresAt <= Date.now())
        throw new Error('REDBOOK_HANDOFF_CANCELLED');
      const cookies = { ...parsed.cookies },
        abort = new AbortController(),
        expiresAt = parsed.expiresAt;
      const client = new RedbookClient({
        transport: createRedbookHttpTransport(abort.signal),
        cookies: () => {
          if (abort.signal.aborted || Date.now() >= expiresAt)
            throw new Error('REDBOOK_SESSION_EXPIRED');
          return { ...cookies };
        },
      });
      const timer = setTimeout(() => {
        void this.revoke().catch(() => undefined);
      }, expiresAt - Date.now());
      timer.unref();
      this.diagnostic = {
        cookies,
        abort,
        expiresAt,
        client,
        store,
        timer,
        creatorId: creator.id,
        authorId: author,
        profileUrl: creator.profileUrl,
        phase: 'ready',
        listSpent: false,
        detailSpent: false,
        imagesSpent: false,
        imageAttempts: 0,
        notes: [],
        images: [],
      };
      return this.diagnosticStatus();
    } finally {
      this.changing = false;
    }
  }
  private currentDiagnostic() {
    const diagnostic = this.diagnostic;
    if (diagnostic && Date.now() >= diagnostic.expiresAt)
      void this.clearDiagnostic().catch(() => undefined);
    if (
      !diagnostic ||
      Date.now() >= diagnostic.expiresAt ||
      diagnostic.abort.signal.aborted ||
      diagnostic.phase === 'paused' ||
      diagnostic.flight ||
      this.active ||
      this.changing
    )
      throw new Error('REDBOOK_DIAGNOSTIC_UNAVAILABLE');
    return diagnostic;
  }
  private async diagnosticRequest(
    diagnostic: DiagnosticSession,
    run: () => Promise<void>,
  ) {
    this.active++;
    let finished!: () => void;
    diagnostic.flight = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      await diagnostic.store.exclusive(
        REDBOOK_QUEUE_SCOPE,
        async (state, save) => {
          if (state && state.phase !== 'ready')
            throw new Error('REDBOOK_SOURCE_PAUSED');
          await save({
            ...freshRedbookState(REDBOOK_QUEUE_SCOPE),
            phase: 'requesting',
            pages: 1,
          });
          try {
            await run();
            if (
              this.diagnostic !== diagnostic ||
              diagnostic.abort.signal.aborted
            )
              throw new Error('REDBOOK_DIAGNOSTIC_CANCELLED');
            await save(freshRedbookState(REDBOOK_QUEUE_SCOPE));
            if (
              this.diagnostic !== diagnostic ||
              diagnostic.abort.signal.aborted
            ) {
              await save({
                ...freshRedbookState(REDBOOK_QUEUE_SCOPE),
                phase: 'paused',
                reason: 'operator',
              });
              throw new Error('REDBOOK_DIAGNOSTIC_CANCELLED');
            }
          } catch (error) {
            await save({
              ...freshRedbookState(REDBOOK_QUEUE_SCOPE),
              phase: 'paused',
              reason: diagnostic.abort.signal.aborted
                ? 'interrupted'
                : 'upstream',
            });
            throw error;
          }
        },
      );
      return this.diagnosticStatus();
    } catch (error) {
      diagnostic.phase = 'paused';
      diagnostic.stopCategory =
        error instanceof RedbookPauseError
          ? error.reason
          : diagnostic.abort.signal.aborted
            ? 'cancelled'
            : 'response';
      // Stop retaining login fields as soon as the platform/transport rejects the diagnostic.
      const secrets = [
        ...Object.values(diagnostic.cookies),
        ...diagnostic.notes.map((note) => note.xsecToken),
      ];
      diagnostic.list = diagnosticPreview(diagnostic.list, secrets);
      diagnostic.detail = diagnosticPreview(diagnostic.detail, secrets);
      diagnostic.notes = [];
      for (const key of Object.keys(diagnostic.cookies))
        delete diagnostic.cookies[key];
      diagnostic.abort.abort();
      throw new Error('REDBOOK_DIAGNOSTIC_STOPPED');
    } finally {
      this.active--;
      diagnostic.flight = undefined;
      finished();
    }
  }
  async diagnosticList(raw: unknown) {
    diagnosticConfirm.parse(raw);
    const diagnostic = this.currentDiagnostic();
    if (diagnostic.listSpent) throw new Error('REDBOOK_DIAGNOSTIC_BUDGET');
    diagnostic.listSpent = true;
    return this.diagnosticRequest(diagnostic, async () => {
      diagnostic.list = await diagnostic.client.getUserNotes(
        diagnostic.authorId,
        '',
      );
      diagnostic.notes = mapRedbookPage(
        diagnostic.list,
        diagnostic.authorId,
      ).notes;
      diagnostic.phase = 'listed';
    });
  }
  async diagnosticDetail(raw: unknown) {
    const parsed = diagnosticDetailInput.parse(raw),
      diagnostic = this.currentDiagnostic();
    const note = diagnostic.notes.find((item) => item.noteId === parsed.noteId);
    if (!diagnostic.listSpent || diagnostic.detailSpent || !note)
      throw new Error('REDBOOK_DIAGNOSTIC_BUDGET');
    diagnostic.detailSpent = true;
    diagnostic.noteId = note.noteId;
    return this.diagnosticRequest(diagnostic, async () => {
      diagnostic.detail = await diagnostic.client.getNoteById(
        note.noteId,
        note.xsecToken,
      );
      inspectRedbookDetail(diagnostic.detail, diagnostic.authorId, note.noteId);
      diagnostic.phase = 'sample-ready';
    });
  }
  async diagnosticImages(raw: unknown) {
    const parsed = diagnosticImageInput.parse(raw),
      diagnostic = this.currentDiagnostic();
    if (
      diagnostic.phase !== 'sample-ready' ||
      diagnostic.imagesSpent ||
      !diagnostic.noteId
    )
      throw new Error('REDBOOK_DIAGNOSTIC_BUDGET');
    const detail = inspectRedbookDetail(
      diagnostic.detail,
      diagnostic.authorId,
      diagnostic.noteId,
    );
    if (!detail.urls.length) throw new Error('REDBOOK_DIAGNOSTIC_NO_IMAGES');
    diagnostic.imagesSpent = true;
    return this.diagnosticRequest(diagnostic, async () => {
      let remaining = parsed.maxBytes;
      for (const url of detail.urls.slice(0, parsed.maxImages)) {
        if (
          this.diagnostic !== diagnostic ||
          diagnostic.abort.signal.aborted ||
          Date.now() >= diagnostic.expiresAt
        )
          throw new Error('REDBOOK_DIAGNOSTIC_CANCELLED');
        if (remaining <= 0) throw new Error('REDBOOK_DIAGNOSTIC_IMAGE_BUDGET');
        diagnostic.imageAttempts++;
        const response = await createRedbookMediaHttpTransport(
          diagnostic.abort.signal,
          remaining,
        )(url, {
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' },
          signal: AbortSignal.timeout(10000),
        });
        const type = (response.headers.get('content-type') || '').split(';')[0];
        if (
          response.status !== 200 ||
          response.redirected ||
          !/^image\/(png|jpeg|gif|webp)$/.test(type)
        )
          throw new Error('REDBOOK_DIAGNOSTIC_IMAGE');
        const bytes = Buffer.from(await response.arrayBuffer());
        remaining -= bytes.length;
        const inlineData = `data:${type};base64,${bytes.toString('base64')}`;
        decodeInlineImage(inlineData);
        diagnostic.images.push({
          ordinal: diagnostic.images.length + 1,
          inlineData,
          bytes: bytes.length,
        });
      }
    });
  }
  diagnosticSample() {
    const diagnostic = this.diagnostic;
    if (!diagnostic || Date.now() >= diagnostic.expiresAt)
      throw new Error('REDBOOK_DIAGNOSTIC_UNAVAILABLE');
    const secrets = [
      ...Object.values(diagnostic.cookies),
      ...diagnostic.notes.map((note) => note.xsecToken),
    ];
    return {
      ...this.diagnosticStatus(),
      list: diagnosticPreview(diagnostic.list, secrets),
      detail: diagnosticPreview(diagnostic.detail, secrets),
      images: diagnostic.images,
    };
  }
  async approveDiagnostic(raw: unknown) {
    const reference = diagnosticReviewInput.parse(raw),
      diagnostic = this.currentDiagnostic();
    if (diagnostic.phase !== 'sample-ready' || !diagnostic.noteId)
      throw new Error('REDBOOK_REVIEW_REQUIRED');
    const detail = inspectRedbookDetail(
      diagnostic.detail,
      diagnostic.authorId,
      diagnostic.noteId,
    );
    if (
      reference.observedImageCount !== detail.urls.length ||
      reference.observedText !== detail.text ||
      reference.publishedAt !== detail.publishedAt
    )
      throw new Error('REDBOOK_REVIEW_REFERENCE_MISMATCH');
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const handoff = {
      cookies: { ...diagnostic.cookies },
      expiresAt: Math.min(diagnostic.expiresAt, Date.now() + 2 * 3600000),
      bindings: [
        {
          creatorId: diagnostic.creatorId,
          authorId: diagnostic.authorId,
          profileUrl: diagnostic.profileUrl,
          review: {
            contract: REDBOOK_RESPONSE_CONTRACT,
            reviewedAt: Date.now(),
            authorIdentityChecked: reference.authorIdentityChecked,
            fullTextChecked: reference.fullTextChecked,
            allImagesChecked: reference.allImagesChecked,
            publicationTimeChecked: reference.publicationTimeChecked,
            noteId: diagnostic.noteId,
            publishedAt: reference.publishedAt,
            textSha256: digest(reference.observedText),
            imageUrlSha256s: detail.urls.map((url) => digest(url.href)),
            list: diagnostic.list,
            detail: diagnostic.detail,
          },
        },
      ],
    };
    this.diagnostic = undefined;
    clearTimeout(diagnostic.timer);
    try {
      return await this.install(handoff);
    } finally {
      diagnostic.abort.abort();
      for (const key of Object.keys(diagnostic.cookies))
        delete diagnostic.cookies[key];
      diagnostic.list = undefined;
      diagnostic.detail = undefined;
      diagnostic.notes = [];
      diagnostic.images = [];
    }
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
