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
        'set-cookie': [
          'wr_vid=123; Path=/; Secure',
          'wr_skey=renewed-web-token; Path=/; Secure',
        ],
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

  it('renews with a live same-owner refresh cookie while omitting an expired key', async () => {
    const input = session();
    input.capturedAt = new Date(Date.now() - 60000).toISOString();
    input.cookies.find((c) => c.name === 'wr_skey')!.expires =
      Date.now() / 1000 - 1;
    const original = JSON.stringify(input);
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: { succ: 1 },
      headers: {
        'set-cookie': [
          'wr_vid=123; Path=/; Secure; Max-Age=5400',
          'wr_skey=fresh-after-expiry; Path=/; Secure; Max-Age=5400',
        ],
      },
    });
    const result = await renewDirectWebTicket(input, '123');
    const header = (axios.post as jest.Mock).mock.calls[0][2].headers.Cookie;
    expect(header).toContain('wr_vid=123');
    expect(header).toContain('wr_rt=fresh-web-refresh');
    expect(header).not.toContain('wr_skey=');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(result.session.capturedAt).toBe(input.capturedAt);
    expect(ownerSessionCookie(result.session, '123')).toContain(
      'wr_skey=fresh-after-expiry',
    );
    expect(JSON.stringify(input)).toBe(original);
  });

  it('does not request normal renewal with an expired refresh credential', async () => {
    const input = session();
    input.capturedAt = new Date(Date.now() - 60000).toISOString();
    input.cookies.find((c) => c.name === 'wr_rt')!.expires =
      Date.now() / 1000 - 1;
    await expect(renewDirectWebTicket(input, '123')).rejects.toThrow(
      'WEB_RENEWAL_REFRESH_TOKEN_MISSING',
    );
    expect(axios.post).not.toHaveBeenCalled();
  });
});
