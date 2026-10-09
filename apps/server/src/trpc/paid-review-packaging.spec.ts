import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const script = fs.readFileSync(
  path.resolve(__dirname, '../../../../scripts/build-paid-plan-review.cjs'),
  'utf8',
);
const code = 'const text="$&";let i=1,$=2;const result=i<$&&true;';
function packageFixture(prototype: string) {
  const written = new Map<string, string>();
  const overview =
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src none" /></head><body>Overview</body></html>';
  vm.runInNewContext(
    script,
    {
      __dirname: path.resolve(__dirname, '../../../../scripts'),
      process: { execPath: process.execPath },
      console: { log: jest.fn() },
      require: (name: string) =>
        name === 'node:fs'
          ? {
              readFileSync: (filename: string, encoding?: string) => {
                const value =
                  written.get(filename) ??
                  (filename.endsWith('WeWe-跨端交互原型.html')
                    ? prototype
                    : filename.endsWith('REVIEW.html')
                      ? overview
                      : '# 合成文档\n$& <script>untrusted</script>');
                return encoding ? value : Buffer.from(value);
              },
              writeFileSync: (filename: string, value: string) =>
                written.set(filename, value),
            }
          : require(name),
    },
    { timeout: 10000 },
  );
  return [...written.entries()].find(([filename]) =>
    filename.endsWith('WeWe订阅开发计划.html'),
  )![1];
}
describe('actual final HTML packager (offline fixture)', () => {
  it('preserves dollar replacement tokens in compiled JS/CSS and embeds only escaped documents', () => {
    const html = packageFixture(
      `<html><head><style>/* $& */ .a{color:red}</style></head><body><div id="root"></div><script type="module">${code}</script></body></html>`,
    );
    const packaged = html.match(
      /<script type="module">([\s\S]*?)<\/script>/,
    )![1];
    expect(packaged).toBe(code);
    expect(() => new vm.Script(packaged)).not.toThrow();
    expect(html).toContain('/* $& */');
    expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;');
    expect(html).toContain("connect-src 'none'");
    expect(html.match(/id="full-document-/g)).toHaveLength(7);
    expect(html).toContain('本轮更新与剩余事项');
  });
  it('rejects invalid bundled code before producing a deliverable', () => {
    expect(() =>
      packageFixture(
        '<style>.a{color:red}</style><script type="module">const broken=;</script>',
      ),
    ).toThrow('INLINE_SCRIPT_SYNTAX_INVALID');
  });
});
