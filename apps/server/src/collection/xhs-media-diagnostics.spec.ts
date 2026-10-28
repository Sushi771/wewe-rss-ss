import { mapRedbookDetail } from './redbook-response';
import { XhsMediaError } from './xhs-media-error';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';

const data = { items: [{ id:'synthetic-note', note_card:{note_id:'synthetic-note',user:{user_id:'synthetic-author'},type:'normal',time:1760000000000,title:'synthetic',desc:'body',image_list:[{url_default:'https://sns-webpic.xhscdn.com/synthetic?token=synthetic-secret'}]} }] };
const map = (transport: any) => mapRedbookDetail(data, 'synthetic-author', 'synthetic-note', transport);
it.each([403,429,461,500,503])('preserves observed status %s without response content or URL', async (status) => {
  const transport = jest.fn(async () => new Response('synthetic-secret', {status}));
  const error = await map(transport).catch((e) => e);
  expect(xhsPublicCode(error, 'fallback')).toBe(`XHS_MEDIA_HTTP_${status}`);
  expect(String(error)).not.toContain('synthetic-secret');
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each([
  ['empty', () => new Response(null, {status:200, headers:{'content-type':'image/png'}}), 'XHS_MEDIA_EMPTY'],
  ['empty stream', () => new Response('', {status:200, headers:{'content-type':'image/png'}}), 'XHS_MEDIA_EMPTY'],
  ['type', () => new Response('synthetic-secret', {status:200, headers:{'content-type':'text/html'}}), 'XHS_MEDIA_TYPE_REJECTED'],
  ['bytes', () => new Response('invalid', {status:200, headers:{'content-type':'image/png'}}), 'XHS_MEDIA_BYTES_INVALID'],
])('reports fixed %s classification', async (_label, response, expected) => {
  const error = await map(async () => response()).catch((e) => e);
  expect(xhsPublicCode(error, 'fallback')).toBe(expected);
  expect(String(error)).not.toContain('synthetic-secret');
});
it('retains control and fixed media errors while hiding arbitrary transport exceptions', async () => {
  for (const error of [new XhsSubscriptionError('XHS_TASK_CANCELLED'), new XhsMediaError('XHS_MEDIA_TIMEOUT')])
    expect(await map(async () => { throw error; }).catch((e) => e)).toBe(error);
  const error = await map(async () => { throw Error('https://private.invalid/?token=synthetic-secret'); }).catch((e) => e);
  expect(xhsPublicCode(error, 'fallback')).toBe('XHS_MEDIA_TRANSPORT_FAILED');
  expect(String(error)).not.toMatch(/private|synthetic-secret/);
});
