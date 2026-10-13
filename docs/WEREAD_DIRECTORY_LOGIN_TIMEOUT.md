# Directory login timeout: offline diagnosis (2026-10-04)

The authorized original refresh stopped at its first `/web/mp/articles` request:
HTTP 200, `errCode=-2012`, `errMsg=登录超时`. No directory was parsed, and no
body, image or article insertion followed. This is an authentication failure,
not evidence that the publisher has no new posts, a malformed directory, or a
repeat of the historical `-2041` challenge. Latest-ten acceptance remains open.

## Evidence and limits

The immutable response is 70 bytes; `info` is empty and `errLog` is a nonempty
trace string retained privately. No extra cause is supplied in that response.
An in-memory comparison of the saved session, binding and stop confirms the
same account and authentication hash. The cookie domain, path and Secure flags
are valid. The request was about 113.7 minutes after capture. Saved cookies have
session expiry (`-1`), which does not establish the server-side token lifetime.
Therefore elapsed age alone cannot prove expiration, revocation, or a missing
reader session initialization. No credentials or trace value are in this file.

The earlier account-profile success used `/api/userInfo` with `x-vid` and
`x-skey`. It establishes that account's profile at that earlier time, not the
later validity of its cookie-only reader request. Earlier browser directory and
body evidence predates this normal QR login and used a different authentication
context; it cannot establish this context's ability to collect ten bodies.

## Established client difference

Existing cached first-party assets were inspected statically; no Tencent
request or signature-runtime execution was needed:

| Client/source                                                                                                                   | Observed behavior                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Homepage `BVQc4ULa.js`, SHA-256 `5b89f8913d89385a1e7a10f840d565e5fac0203f0e4b0e8cc16ea0bb7504bf54`, offsets 185147 and 638502   | Normal QR `accessToken` becomes `wr_skey`; profile requests include `x-vid/x-skey`. This matches `native-web-login.ts`. No reader renewal is present in this bundle.                                              |
| Reader `app.88f998b2.js`, SHA-256 `996a561d9fb7f79bf4289a91e2b6f77dc617eb2bb9352c0320b33c87b9f3bf51`, offsets 634525 and 754493 | Cookie-based requests receiving `-0x7dc` (`-2012`) or `-2010` enter Web login renewal. The request path is encoded as `rq`; a successful renewal can precede a retry. The `-2041` challenge is a separate branch. |
| Reader bundle, offsets 987997 and 1007341                                                                                       | Its older QR flow also calls `/web/login/session/init` after `/web/login/weblogin`. This is a different login flow and does not prove that the newer QR API always needs that initialization.                     |
| Current `fetchOwnerWereadLatest`                                                                                                | Sends the normal saved cookies, records the response, and stops on any business refusal. It neither renews nor initializes a reader session.                                                                      |
| Existing `renewDirectWebTicket`                                                                                                 | Already implements a single normal Web renewal with the saved Web refresh token. The current provider does not call it. Its optional ticket result is not proof of permission or a required directory credential. |

Public implementations corroborate the normal renewal shape and handling of
server-issued cookies: [wereadx login.ts at ae13a14](https://github.com/88825/wereadx/blob/ae13a14ed35bbbc2a4694921a4caa49403eb8e61/src/apis/web/login.ts)
and [weread.koplugin renewal research at 9caeb0f](https://github.com/finlater/weread.koplugin/blob/9caeb0f15fb9ca2b03f0f512d93261f6cb75619d/docs/weread-content-research.md).
These are reusable implementation evidence, not live proof for this login.
No copied browser ticket or generated platform signature is proposed.

## Bounded next decision

Do not change the proven directory parameters or use the mobile route. The
remaining uncertainty is the reader's authenticated session, before directory
parsing. A further network test needs the integration owner's explicit approval
for ordinary Web session maintenance; it is not authorized by this offline
diagnosis. That test would use the already saved normal Web refresh token and
existing renewal implementation once, retain the server result and issued cookie
scope, and make no directory/body retry in the same experiment. Any challenge,
refusal, missing refresh token or expired login stops the experiment. Normal
official login/verification, if required by that result, belongs to the user.

Keep the current stop, authorization, original login snapshot and one-shot
marker intact. A renewed `wr_skey` must not silently become a new login that
releases this stop. Before a later collection is permitted, the owner must
decide how a normal maintenance result is explicitly associated with the
existing failed operation; immutable login evidence and stop ownership remain
requirements. A refreshed profile alone still does not satisfy acceptance.

## Delivered change

The product now translates the known numeric `-2012` reason into a static login
timeout description, including old saved numeric stops when displayed. It does
not pass arbitrary upstream text into the UI, mutate an old stop, renew, or grant
another request. Offline tests exercise HTTP 200 plus this business refusal,
private trace exclusion, raw-response retention and zero follow-up requests.
This diagnostic improvement does not restore real subscription collection.
