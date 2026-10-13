import { diagnosticPreview } from './redbook-diagnostic';

describe('private diagnostic preview redaction', () => {
  it.each([
    ' https://user:pass@x.test/path?xsec_token=unknown#hash',
    '<a href="https://x.test/path?signature=unknown&token=other">link</a>',
    '{"url":"https:\\/\\/x.test/path?signature=unknown"}',
  ])('clears embedded URL queries/userinfo/fragment: %s', (value) => {
    const preview = JSON.stringify(diagnosticPreview({ extra: value }, []));
    for (const secret of ['unknown', 'other', 'user:pass', 'hash'])
      expect(preview).not.toContain(secret);
  });
  it('redacts known cookie and note token values even under unknown keys', () => {
    expect(
      diagnosticPreview(
        { extra: 'contains private-token', cookie: 'other', x_s: 'sig' },
        ['private-token'],
      ),
    ).toEqual({ extra: '[redacted]', cookie: '[redacted]', x_s: '[redacted]' });
  });
});
