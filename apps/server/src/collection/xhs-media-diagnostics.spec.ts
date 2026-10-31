import { mapRedbookBasicDetail, mapRedbookDetail } from './redbook-response';
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

it('keeps the media cancellation signal live after a long synthetic admission wait', async () => {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=','base64');
  const transport=jest.fn(async (_url:any,options:any)=>{await new Promise(r=>setTimeout(r,10100));expect(options.signal.aborted).toBe(false);return new Response(png,{status:200,headers:{'content-type':'image/png'}});});
  await map(transport);expect(transport).toHaveBeenCalledTimes(1);
},20000);

it('extracts identity-bound basic fields independently of media and retains missing values as unknown',()=>{
  const card={note_id:'synthetic-note',user:{user_id:'synthetic-author'},type:'normal',time:1760000000000,title:'t',desc:'body',image_list:[{url_default:'https://evil.invalid/?token=secret'}],interact_info:{liked_count:'7',comment_count:'0'}};
  const basic=mapRedbookBasicDetail({items:[{id:'synthetic-note',note_card:card}]},'synthetic-author','synthetic-note');
  expect(basic).toMatchObject({publishedAt:1760000000,title:'t',text:'body',metrics:{values:{likes:7,comments:0,collects:null,shares:null}}});expect(JSON.stringify(basic)).not.toContain('secret');
  const missing=mapRedbookBasicDetail({items:[{id:'synthetic-note',note_card:{...card,time:null,desc:null}}]},'synthetic-author','synthetic-note');expect(missing.publishedAt).toBeNull();expect(missing.text).toBeNull();
  expect(()=>mapRedbookBasicDetail({items:[{id:'synthetic-note',note_card:card}]},'other','synthetic-note')).toThrow();
});
