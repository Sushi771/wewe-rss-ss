# WeChat desktop article collector

Windows helper for WeWe-RSS. It reads the requested account's visible **文章** page in `WeChatAppEx.exe`, opens cards through the official UI, and uses **更多 → 复制链接**. It does not read WeChat files, chats, sessions, cookies, or previous clipboard contents.

**Acceptance status:** offline fixes are complete; the repaired helper has not passed a real single-article run. The user stopped previous automation with Esc. UI and clipboard operations remain paused pending explicit renewed authorization. See [the repair checkpoint](../../docs/DESKTOP_COLLECTION_REPAIR.md).

## Invocation and pause handling

Only after authorization for the specific desktop operation:

```powershell
# First real validation: one article at most, 60 seconds, no database write.
pwsh -NoProfile -NonInteractive -File tools/wechat-desktop-collector/collect.ps1 -MpId MP_WXS_1234567890 -MpName '示例公众号' -SingleArticleProbe -ResumeAfterUserConsent

# Full collection after the single-article check passes and collection is authorized.
pwsh -NoProfile -NonInteractive -File tools/wechat-desktop-collector/collect.ps1 -MpId MP_WXS_1234567890 -MpName '示例公众号' -Limit 20
```

Esc is latched and prevents further input. A `.paused` file persists cancellation. Only an explicit user resume may supply `-ResumeAfterUserConsent`; scheduled and ordinary refreshes never add it. The application supplies it for the local dedicated start/resume button. A probe returns `probeOnly: true` and cannot be imported by the production 20-article path.

Full success produces one JSON line:

```json
{
  "protocolVersion": 2,
  "account": "公众号名",
  "mpId": "MP_WXS_1234567890",
  "source": "desktop-wechat",
  "articles": [
    {
      "rank": 1,
      "title": "文章标题",
      "shortUrl": "https://mp.weixin.qq.com/s/xxxxxxxxxxxxxxxxxxxxxx"
    }
  ],
  "pinnedArticles": []
}
```

This example abbreviates the array. Production requires 20 unique regular cards; pinned cards are returned separately. Failure exits nonzero, writes a controlled error code, stage and counts to stderr, and produces no partial JSON. The helper never writes a database. The server verifies each original's canonical identity, account, date and body, then combines pinned and ordinary results by date before writing.

## Required UI capabilities

- Windows with PowerShell 7; Windows PowerShell 5.1 is unverified. The local UI Automation assemblies and Win32 APIs need no downloaded helper or .NET SDK.
- A unique `WeChatAppEx.exe` window titled `微信`, with the requested account's **文章** page in the **currently selected tab**. The helper checks the account document, app group, account label, article link and cards; it does not switch to the user's first tab.
- Browser tabs expose unique UIA `TabItem` RuntimeIds and `SelectionItemPattern`, with exactly one selected tab. The list exposes a vertical `ScrollPattern`; resetting to zero restores a stable visible header and first list marker. These capabilities remain unverified on the current WeChat version. Failure stops before opening an article.
- Regular cards have a date, one title and the observed reading metric structure. A bounded pinned card can omit the metric. All titles in each ancestor count, including offscreen ones. Clicked controls must fit fully inside the window. Ambiguous structure and unverified collapsed multi-article controls stop collection.
- Every article opens in exactly one new tab. The helper proves ownership against the original tab set and rechecks before copy/close; after closing it confirms the original set and selection. Text alone never proves ownership. Cancellation, foreground loss or uncertainty may leave the new tab open; it does not close user tabs to recover.
- The desktop stays unlocked and free of competing input. The helper activates WeChat, clicks, scrolls, and replaces the clipboard through the official copy action. It does not read or restore the old clipboard.
- The clipboard sequence changes and the owner belongs to the target process. Both are checked inside the lock before one Unicode read. Only a clean official short URL with a 22-character token is accepted; unrelated content is rejected without logging it.
- Fixed time, scroll and open-attempt budgets prevent loops. Reused card identities, duplicate links, skipped or unsupported cards and stalled lists fail. Failure never proves an account has fewer than 20 articles.

Only the **文章** page is in scope of the implementation. Other content types and full primary/secondary coverage need evidence. Existing articles are never trimmed to 20.

## Application integration

The local dedicated button invokes this helper; public RSS updates cannot operate the desktop. Ordinary refreshes choose it for IDs in `WECHAT_DESKTOP_MP_IDS`; dedicated success does not persist that selection. Scheduled collection additionally requires `WECHAT_DESKTOP_ALLOW_SCHEDULED=1`, defaults off, and respects `.paused`. The matching account page must already be open; automatic multi-account navigation is not implemented.

SQLite collection starts only after `apps/server/scripts/backup-sqlite.py` creates an online backup and checks integrity and SHA-256, before even status writes. Windows uses `python`, other platforms use `python3`; `SQLITE_BACKUP_PYTHON` can specify one executable path. The SQLite Docker stage includes Python 3. Desktop collection requires SQLite; existing non-desktop MySQL paths retain an explicit compatibility bypass.

## Offline checks

```powershell
pwsh -NoProfile -NonInteractive -File tools/wechat-desktop-collector/collect.ps1 -SelfTest
pwsh -NoProfile -NonInteractive -File tools/wechat-desktop-collector/offline-tests.ps1
```

`-SelfTest` compiles the bridge and tests pure link/title checks, then exits before UI or clipboard operations. `offline-tests.ps1` imports only AST-allowlisted functions and mocks all UI/native actions; it requires `nativeHelperLoaded=false`. Neither check proves real tab ownership, scroll support, Esc handling or 20-article acceptance.

The design was informed by public behavior documented in `Access_wechat_article`; no code was copied from that CC BY-NC-SA 4.0 project.
