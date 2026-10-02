import axios from 'axios';
import {
  OwnerWebSession,
  ownerSessionCookie,
} from '../collection/owner-web-search';
import { renewDirectWebTicket } from './native-web-ticket';

jest.mock('axios');

const session = (): OwnerWebSession => ({
  source: 'owner-confirmed-native-web-login',
  capturedAt: new Date().toISOString(),
  ownerVid: '123',
  cookies: [
    ['wr_vid', '123'],
    ['wr_skey', 'old-web-token'],
    ['wr_ql', '0'],
    ['wr_rt', 'fresh-web-refresh'],
  ].map(([name, value]) => ({
    name,
    value,
    domain: '.weread.qq.com',
    path: '/',
    secure: true,
    expires: -1,
  })),
});

describe('direct Web renewal ticket gate (offline)', () => {
  beforeEach(() => jest.resetAllMocks());

  it('requires a direct Web refresh token before any request', async () => {
    const input = session();
    input.cookies = input.cookies.filter((cookie) => cookie.name !== 'wr_rt');
    await expect(renewDirectWebTicket(input, '123')).rejects.toThrow(
      'WEB_RENEWAL_REFRESH_TOKEN_MISSING',
    );
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('makes one renewal request and preserves returned credentials in memory', async () => {
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: { succ: 1 },
      headers: {
        'set-cookie': ['wr_skey=renewed-web-token; Path=/; Secure'],
        'x-wr-ticket': 'ticket-value',
        'x-wrpa-0': 'wrpa-value',
      },
    });
    const result = await renewDirectWebTicket(session(), '123');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      'https://weread.qq.com/web/login/renewal',
      { rq: '%2Fweb%2Fbook%2Fread', ql: false },
      expect.objectContaining({ maxRedirects: 0, proxy: false }),
    );
    expect(ownerSessionCookie(result.session, '123')).toContain(
      'wr_skey=renewed-web-token',
    );
    expect(result.ticket).toBe('ticket-value');
    expect(result.wrpa).toBe('wrpa-value');
  });

  it('stops on a business rejection without retry or credential output', async () => {
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: { errCode: -2013, errMsg: 'private upstream details' },
      headers: {},
    });
    await expect(renewDirectWebTicket(session(), '123')).rejects.toThrow(
      'WEB_RENEWAL_BUSINESS_STOP',
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
