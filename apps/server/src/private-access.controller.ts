import { Body, Controller, Post, Response } from '@nestjs/common';
import { Response as Res } from 'express';
import {
  clearSessionCookie,
  newSession,
  privateOnlineMode,
  setSessionCookie,
  verifyAccessCode,
} from './private-access';

@Controller('auth')
export class PrivateAccessController {
  @Post('login')
  login(@Body('code') code: string, @Response() res: Res) {
    if (!privateOnlineMode() || !verifyAccessCode(code))
      return res.status(401).json({ error: '登录码无效' });
    setSessionCookie(res, newSession());
    return res.status(204).send();
  }

  @Post('logout')
  logout(@Response() res: Res) {
    clearSessionCookie(res);
    return res.status(204).send();
  }
}
