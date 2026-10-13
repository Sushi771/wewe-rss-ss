import {
  Body,
  Controller,
  Inject,
  Options,
  Post,
  Request,
  Response,
} from '@nestjs/common';
import { Request as Req, Response as Res } from 'express';
import { BrowserTaskBroker, BrowserTaskError } from './browser-task';

/** Opt-in registration only; AppModule deliberately does not include this route.
 * This receives observations for an internally issued task, never arbitrary HTML
 * imports or a caller-supplied verified article. No request/response logging.
 */
@Controller('browser-task')
export class BrowserTaskController {
  constructor(
    @Inject(BrowserTaskBroker) private readonly broker: BrowserTaskBroker,
  ) {}
  private headers(res: Res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  private invoke(req: Req, res: Res, run: () => unknown) {
    this.headers(res);
    try {
      const origin = this.broker.authorize(req);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      return res.status(200).json(run());
    } catch (error) {
      return res
        .status(error instanceof BrowserTaskError ? error.status : 422)
        .json({
          code:
            error instanceof BrowserTaskError
              ? error.code
              : 'OBSERVATION_REJECTED',
        });
    }
  }
  @Options(':stage')
  preflight(@Request() req: Req, @Response() res: Res) {
    this.headers(res);
    try {
      const origin = this.broker.preflight(req);
      const names = String(req.headers['access-control-request-headers'] || '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .sort();
      if (
        req.headers['access-control-request-method'] !== 'POST' ||
        JSON.stringify(names) !==
          JSON.stringify(['content-type', 'x-wewe-pairing'])
      )
        throw new BrowserTaskError('PREFLIGHT_INVALID', 403);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-WeWe-Pairing',
      );
      return res.status(204).end();
    } catch (error) {
      return res
        .status(error instanceof BrowserTaskError ? error.status : 403)
        .json({
          code:
            error instanceof BrowserTaskError
              ? error.code
              : 'PREFLIGHT_INVALID',
        });
    }
  }
  @Post('claim')
  claim(@Body() body: any, @Request() req: Req, @Response() res: Res) {
    return this.invoke(req, res, () => {
      if (
        !body ||
        Object.keys(body).some((k) => !['taskId', 'binding'].includes(k))
      )
        throw new BrowserTaskError('INPUT_SCHEMA', 400);
      return this.broker.claim(body.taskId, body.binding);
    });
  }
  @Post('complete')
  complete(@Body() body: any, @Request() req: Req, @Response() res: Res) {
    return this.invoke(req, res, () => {
      if (
        !body ||
        Object.keys(body).some(
          (k) => !['taskId', 'binding', 'nonce', 'observation'].includes(k),
        )
      )
        throw new BrowserTaskError('INPUT_SCHEMA', 400);
      return this.broker.complete(
        body.taskId,
        body.nonce,
        body.binding,
        body.observation,
      );
    });
  }
  @Post('cancel')
  cancel(@Body() body: any, @Request() req: Req, @Response() res: Res) {
    return this.invoke(req, res, () => {
      if (
        !body ||
        Object.keys(body).some(
          (k) => !['taskId', 'binding', 'nonce'].includes(k),
        ) ||
        typeof body.nonce !== 'string'
      )
        throw new BrowserTaskError('INPUT_SCHEMA', 400);
      this.broker.cancel(body.taskId, body.nonce, body.binding);
      return { cancelled: true };
    });
  }
}
