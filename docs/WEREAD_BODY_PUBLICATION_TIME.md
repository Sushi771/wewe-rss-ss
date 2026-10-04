# WeRead directory time and original body publication time

The saved renewed-session directory and first three bodies expose two sources.
The first two agree numerically. For the third, directory `mpInfo.time` is
1790555438 while the body's `ori_create_time`, `ori_send_time`,
`create_timestamp`, `create_time` and `ct` consistently identify 1790555400.
The 38-second difference does not establish a universal rounding rule or the
directory field's server-side generation event. No numeric tolerance is added.

The cached first-party catalog asset `19.42e251bc.js`, SHA-256
`85bea05005a543894c346a39cae5a234b9d77de322316b3a80e87de809af3a3e`,
renders the catalog group's `createTime` with `itemShowTime` at offset 463007.
It does not compare directory metadata with the original body's CGI time.
The original HTML's explicit creation/send fields are the publication source;
the existing `articlePublishTime` already requires their internal agreement,
original body structure and a valid Unix timestamp. This existing parser is
reused unchanged, including rejection of missing, conflicting or invalid fields.

The adapter now calls the directory value `directoryTime`: it is retained for
ordering, latest-window selection and duplicate-directory conflict checks.
Only the independently verified original body time becomes
`ProviderArticle.publishTime`, the saved article/RSS publication source. No
directory, group, sync/index or current-clock time fills a missing body time.
Canonical URL, short-link binding, `biz/mid/idx`, publisher, title, body structure,
images and saved-response hashes retain their existing checks. Protected SQLite
save still rejects a conflicting previously trusted publication time and rolls
back the whole batch; this patch does not authorize overwriting old data.

Offline verification uses only the already saved directory and three bodies,
checks their recorded SHA-256 values and writes a private diagnostic report.
No raw bodies, publisher identity or session credentials are committed. The
current stop and consumed attempt remain intact; no platform retry, renewal,
activation or expiry extension is performed. Real ten-body/image collection
and any reviewed continuation remain the integration owner's responsibility.
