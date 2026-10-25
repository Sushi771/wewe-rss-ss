# Audited local Redbook subset

Source: [lucasygu/redbook](https://github.com/lucasygu/redbook), v0.8.2,
commit `801a09847699a2bae5560eeefd901e3afdde469b`, MIT. Retained license:
[REDBOOK-LICENSE.txt](REDBOOK-LICENSE.txt). Upstream attributes the signing
algorithm to Cloxl/xhshow under MIT.

Only local XYS signing is vendored. The surrounding client reproduces the
read-only `getUserNotes` and `getNoteById` request shapes. No CLI, installation
script, browser-cookie code, write endpoint, creator API, global RedNote
backend, alternate XYW signature, retry, v1 list fallback, or HTML fallback is
included. Upstream `postinstall` is not executed. No additional package is
installed.

Compatibility: although the original package declares Node >=22 and ESM, this
subset uses only `node:crypto`, Buffer, URL and BigInt, which are available in
the project's Node 20.16 runtime. It is compiled as existing Nest CommonJS;
there is no import of the original ESM package. This runtime conclusion comes
from the retained APIs, not a Node 20 live-platform test.

The full randomized device fingerprint was trimmed to the fields actually
consumed by B1 generation. Local signing parity with the audited upstream was
checked using synthetic cookies and fixed entropy for both GET and POST;
`redbook-client.spec.ts` retains SHA-256 golden vectors for all five headers.
Neither parity nor fixture success proves that the platform currently accepts
these signatures.

The client defaults to disabled transport. The local runtime supplies an explicit
in-memory credential handoff and constrained transport only behind the original
default-off live gate. Comment/reply reads have a second independent default-off
XHS_COMMENT_COLLECTION_ENABLED gate; status reads do not load credentials.
That transport must enforce the supplied 15-second timeout, 8 MiB response
limit, redirect rejection, and zero retries. The only host is `edith.xiaohongshu.com`. No media download is
performed by this client and account cookies must never enter media requests.

Only `jpg,webp` is requested. AVIF output is unsupported by the existing image
contract and must be rejected by byte validation, never relabeled. Real image
URL/schema completeness, real signatures, credentials, and actual list/detail
responses remain unverified. All current fixtures are synthetic.
