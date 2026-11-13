# Isolated browser fixture readiness

The shared offline browser fixture uses the existing `browser-readiness.cjs` helper. One browser launch has a thirty-second startup deadline covering debugging-port discovery, a responding local debugging endpoint with an `about:blank` page, and the WebSocket opening. A valid port may be published through the owned profile's port file or the launched child's stderr. Empty or invalid ports do not authorize a request. There is no browser relaunch or test retry.

Spawn failure, early process exit, endpoint failure and deadline exhaustion remain failures. WebSocket errors and exits during connection also fail. Existing page navigation, rendering, folder ordering, SQLite assertions and fixture cleanup remain in place. Cleanup retains its separate bounded exit waits and removes the owned temporary fixture only after confirmed child exit when requested by the caller.

The observed CI startup failure established only that the port file had not appeared within the previous ten-second wait. An empty stderr stream and an unreported process exit do not establish why readiness was absent. A successful same-commit run does not prove that extending the deadline resolves the underlying cause.

Run `node --test scripts/browser-readiness.test.cjs` for synthetic coverage without launching a browser or making network requests. The shared-fixture wiring cases use in-memory processes, server and WebSocket with the real readiness helper, covering missing readiness, spawn failure, early exit, socket timeout/error/exit and unchanged business-error propagation. They check one launch, a shared deadline, callback exclusion before readiness and cleanup. The existing helper cases cover late startup, invalid ports, endpoint failures and rejected remote debugging URLs.

The original `node --test scripts/xhs-folder-sqlite-browser.test.cjs` remains the real isolated browser and SQLite acceptance check. Synthetic success alone does not establish that this check, full CI or production recovery has succeeded.
