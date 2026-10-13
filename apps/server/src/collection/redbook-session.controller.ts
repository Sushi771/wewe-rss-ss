import { Body, Controller, Get, Post, Request, Response } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request as Req, Response as Res } from 'express';
import { redbookLocalAccess } from './redbook-local-access';
import { RedbookRuntime } from './redbook-runtime';

/** Backend private session handoff only. Not in tRPC, page state or browser storage. */
@Controller('local/redbook')
export class RedbookSessionController {
  constructor(
    private readonly config: ConfigService,
    private readonly runtime: RedbookRuntime,
  ) {}
  private authorized(req: Req, res: Res) {
    res.setHeader('Cache-Control', 'no-store');
    if (
      process.env.WEWE_ACCEPTANCE_MODE === '1' ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        req.socket.remoteAddress || '',
      )
    ) {
      res.status(403).json({ code: 'REDBOOK_LOCAL_ONLY' });
      return false;
    }
    const code = this.config.get<string>('auth.code');
    if (!code || req.headers.authorization !== code) {
      res.status(401).json({ code: 'REDBOOK_AUTH_REQUIRED' });
      return false;
    }
    if (!redbookLocalAccess(req, code)) {
      res.status(403).json({ code: 'REDBOOK_ORIGIN_REJECTED' });
      return false;
    }
    return true;
  }
  @Get('status')
  status(@Request() req: Req, @Response() res: Res) {
    if (!this.authorized(req, res)) return;
    return res.json(this.runtime.status());
  }
  @Post('session')
  async install(
    @Request() req: Req,
    @Response() res: Res,
    @Body() body: unknown,
  ) {
    if (!this.authorized(req, res)) return;
    try {
      if (Buffer.byteLength(JSON.stringify(body) || '') > 4_000_000)
        throw Error();
      return res.json(await this.runtime.install(body));
    } catch {
      return res.status(422).json({
        code: 'REDBOOK_HANDOFF_REJECTED',
        message: '请核对会话有效期、证据参考值和已有博主绑定；未请求平台。',
      });
    }
  }
  @Post('revoke')
  async revoke(@Request() req: Req, @Response() res: Res) {
    if (!this.authorized(req, res)) return;
    try {
      await this.runtime.revoke();
      return res.json({ revoked: true });
    } catch {
      return res
        .status(409)
        .json({ code: 'REDBOOK_PAUSE_CHECKPOINT_FAILED', revoked: true });
    }
  }
  @Post('resume-operator')
  async resume(
    @Request() req: Req,
    @Response() res: Res,
    @Body() body: unknown,
  ) {
    if (!this.authorized(req, res)) return;
    try {
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).length !== 1 ||
        typeof (body as { creatorId?: unknown }).creatorId !== 'string'
      )
        throw Error();
      await this.runtime.resumeOperator(
        (body as { creatorId: string }).creatorId,
      );
      return res.json({ resumed: true });
    } catch {
      return res.status(409).json({ code: 'REDBOOK_RESUME_BLOCKED' });
    }
  }
  private async diagnosticAction(
    req: Req,
    res: Res,
    action: () => unknown | Promise<unknown>,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    if (!this.authorized(req, res)) return;
    try {
      return res.json(await action());
    } catch {
      return res.status(422).json({
        code: 'REDBOOK_DIAGNOSTIC_REJECTED',
        message: '本次操作未完成；请核对输入或停止原因，不会自动重试。',
        diagnostic: this.runtime.diagnosticStatus(),
      });
    }
  }
  @Post('diagnostic/status')
  diagnosticStatus(@Request() req: Req, @Response() res: Res) {
    return this.diagnosticAction(req, res, () =>
      this.runtime.diagnosticStatus(),
    );
  }
  @Post('diagnostic/session')
  diagnosticSession(
    @Request() req: Req,
    @Response() res: Res,
    @Body() body: unknown,
  ) {
    return this.diagnosticAction(req, res, () =>
      this.runtime.startDiagnostic(body),
    );
  }
  @Post('diagnostic/list')
  diagnosticList(
    @Request() req: Req,
    @Response() res: Res,
    @Body() body: unknown,
  ) {
    return this.diagnosticAction(req, res, () =>
      this.runtime.diagnosticList(body),
    );
  }
  @Post('diagnostic/detail')
  diagnosticDetail(
    @Request() req: Req,
    @Response() res: Res,
    @Body() body: unknown,
  ) {
    return this.diagnosticAction(req, res, () =>
      this.runtime.diagnosticDetail(body),
    );
  }
  @Post('diagnostic/images')
  diagnosticImages(
    @Request() req: Req,
    @Response() res: Res,
    @Body() body: unknown,
  ) {
    return this.diagnosticAction(req, res, () =>
      this.runtime.diagnosticImages(body),
    );
  }
  @Post('diagnostic/sample')
  diagnosticSample(@Request() req: Req, @Response() res: Res) {
    return this.diagnosticAction(req, res, () =>
      this.runtime.diagnosticSample(),
    );
  }
  @Post('diagnostic/review')
  diagnosticReview(
    @Request() req: Req,
    @Response() res: Res,
    @Body() body: unknown,
  ) {
    return this.diagnosticAction(req, res, () =>
      this.runtime.approveDiagnostic(body),
    );
  }
  @Post('diagnostic/discard')
  diagnosticDiscard(@Request() req: Req, @Response() res: Res) {
    return this.diagnosticAction(req, res, async () => {
      await this.runtime.revoke();
      return { discarded: true, configured: false };
    });
  }
}
