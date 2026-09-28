param(
    [string]$MpId,
    [string]$MpName,
    [ValidateRange(1, 20)][int]$Limit = 20,
    [switch]$SelfTest,
    [switch]$SingleArticleProbe,
    [switch]$ResumeAfterUserConsent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Never send progress or partial results to stdout. The caller parses only the final JSON line.
function Fail([string]$Reason) { throw [System.InvalidOperationException]::new($Reason) }
function Note([string]$Message) { [Console]::Error.WriteLine($Message) }
$script:Stage = 'INITIALIZE'
$script:Diagnostic = @{}

function Set-Stage([string]$Stage) {
    $script:Stage = $Stage
    $script:Diagnostic = @{}
}

function Get-FailureCode($ErrorRecord) {
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($exception.Message -cmatch '^[A-Z][A-Z0-9_]+$') { return $exception.Message }
        $exception = $exception.InnerException
    }
    return 'INTERNAL_ERROR'
}

function Parse-ShortUrl([string]$Text) {
    if ($null -eq $Text) { Fail 'COPY_EMPTY' }
    $value = $Text.Trim()
    if ($value -cnotmatch '^https://mp\.weixin\.qq\.com/s/[A-Za-z0-9_-]{22}$') {
        # Do not disclose the unexpected clipboard value, even in an error.
        Fail 'COPY_NOT_CLEAN_SHORT_URL'
    }
    return $value
}

function Normalize-Title([string]$Title) {
    if ($null -eq $Title) { return '' }
    return [regex]::Replace($Title.Normalize([Text.NormalizationForm]::FormKC), '\s+', '').Trim()
}

function Test-DateText([string]$Text) {
    return $Text -match '^(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:\s|$)|^\d{4}-\d{1,2}-\d{1,2}(?:\s|$)|^(今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])(?:\s|$)'
}

function Test-MetricText([string]$Text) {
    return $Text -match '^(?:阅读|点赞|在看|分享|评论)(?:\s|:|：|\d|$)'
}

function Test-NonTitleText([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $true }
    $value = $Text.Trim()
    if (Test-DateText $value) { return $true }
    if (Test-MetricText $value) { return $true }
    return $value -match '^(?:置顶|全部|贴图|文章|更多|复制链接|收起|正在加载\.{3}|已无更多数据|余下\s*\d+\s*篇)$'
}

function Run-SelfTest {
    $good = 'https://mp.weixin.qq.com/s/AAAAAAAAAAAAAAAAAAAAAA'
    if ((Parse-ShortUrl " `t$good `r`n") -cne $good) { Fail 'SELFTEST_GOOD_URL' }
    foreach ($bad in @(
            'https://mp.weixin.qq.com/s/AAAAAAAAAAAAAAAAAAAAAA?foo=1',
            'https://mp.weixin.qq.com/s/AAAAAAAAAAAAAAAAAAAAAA#x',
            'https://evil.example/s/AAAAAAAAAAAAAAAAAAAAAA',
            'https://mp.weixin.qq.com/s/short'
        )) {
        $rejected = $false
        try { $null = Parse-ShortUrl $bad } catch { $rejected = $true }
        if (-not $rejected) { Fail 'SELFTEST_BAD_URL_ACCEPTED' }
    }
    if (-not (Test-DateText '9月26日') -or -not (Test-DateText '星期一')) { Fail 'SELFTEST_DATE' }
    if (-not (Test-MetricText '阅读 1234')) { Fail 'SELFTEST_METRIC' }
    if ((Normalize-Title ' 思维 100 秋季开始报名！ ') -cne '思维100秋季开始报名!') {
        Fail 'SELFTEST_NORMALIZATION'
    }
    if ([Console]::OutputEncoding.WebName -cne 'utf-8') { Fail 'SELFTEST_OUTPUT_ENCODING' }
    [Console]::Out.WriteLine('SELFTEST_UTF8_妈妈号')
    return 'SELFTEST_OK'
}

if (-not $SelfTest) {
    if ($MpId -notmatch '^MP_WXS_\d+$') { Note 'COLLECT_FAILED: INVALID_MP_ID'; exit 1 }
    if ([string]::IsNullOrWhiteSpace($MpName)) { Note 'COLLECT_FAILED: EMPTY_MP_NAME'; exit 1 }
    $MpName = $MpName.Trim()
}

# Compiled in memory; no native DLL, executable, network endpoint, or persistent script is installed.
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WeChatCollectorWin32 {
    private static volatile bool cancelled;
    private static volatile bool watching;
    private static Thread cancelThread;
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    public static void StartCancellationWatch() {
        cancelled = false;
        watching = true;
        cancelThread = new Thread(() => {
            while (watching) {
                if ((GetAsyncKeyState(0x1B) & 0x8001) != 0) cancelled = true;
                Thread.Sleep(20);
            }
        });
        cancelThread.IsBackground = true;
        cancelThread.Start();
    }
    public static void StopCancellationWatch() { watching = false; if (cancelThread != null) cancelThread.Join(100); }
    public static void CheckCancellation() {
        if (cancelled) throw new InvalidOperationException("USER_CANCELLED");
    }
    public static bool CancellationRequested { get { return cancelled; } }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; public POINT(int x, int y) { X=x; Y=y; } }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attached);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
    [DllImport("user32.dll")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] private static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint format);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr handle);

    public static string WindowTitle(IntPtr window) {
        var value = new StringBuilder(256);
        GetWindowTextW(window, value, value.Capacity);
        return value.ToString();
    }
    public static uint ProcessId(IntPtr window) {
        uint id;
        GetWindowThreadProcessId(window, out id);
        return id;
    }
    public static bool ActivateWindow(IntPtr target) {
        var current = GetForegroundWindow();
        if (current == target) return true;
        uint ignored;
        var foregroundThread = GetWindowThreadProcessId(current, out ignored);
        var callerThread = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != callerThread &&
            AttachThreadInput(callerThread, foregroundThread, true);
        try {
            BringWindowToTop(target);
            SetForegroundWindow(target);
            return GetForegroundWindow() == target;
        } finally {
            if (attached) AttachThreadInput(callerThread, foregroundThread, false);
        }
    }
    public static uint ProcessIdAt(int x, int y) {
        return ProcessId(WindowFromPoint(new POINT(x, y)));
    }
    public static void Click(int x, int y) {
        CheckCancellation();
        if (!SetCursorPos(x,y)) throw new InvalidOperationException("CURSOR_MOVE_FAILED");
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
    public static void WheelDown(int x, int y) {
        CheckCancellation();
        if (!SetCursorPos(x,y)) throw new InvalidOperationException("CURSOR_MOVE_FAILED");
        mouse_event(0x0800, 0, 0, -120, UIntPtr.Zero);
    }
    public static void FirstTab() {
        keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl
        keybd_event(0x31, 0, 0, UIntPtr.Zero); // 1
        keybd_event(0x31, 0, 0x0002, UIntPtr.Zero);
        keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
    }
    public static void CloseCurrentTab() {
        CheckCancellation();
        keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl
        keybd_event(0x57, 0, 0, UIntPtr.Zero); // W
        keybd_event(0x57, 0, 0x0002, UIntPtr.Zero);
        keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
    }
    public static void TopOfPage() {
        CheckCancellation();
        keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl
        keybd_event(0x24, 0, 0, UIntPtr.Zero); // Home
        keybd_event(0x24, 0, 0x0002, UIntPtr.Zero);
        keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
    }
    public static string ReadClipboardUnicodeOnce(uint expectedSequence, uint expectedOwnerPid) {
        // Only called after our own copy action and a sequence/owner check.
        bool opened = false;
        for (int attempt = 0; attempt < 20; attempt++) {
            CheckCancellation();
            if (OpenClipboard(IntPtr.Zero)) { opened = true; break; }
            Thread.Sleep(50);
        }
        if (!opened) throw new InvalidOperationException("CLIPBOARD_OPEN_FAILED");
        try {
            // 锁定剪贴板后、读取任何文本前再核对，避免读到用户刚复制的内容。
            CheckCancellation();
            if (GetClipboardSequenceNumber() != expectedSequence)
                throw new InvalidOperationException("CLIPBOARD_CHANGED_BEFORE_READ");
            var owner = GetClipboardOwner();
            if (owner == IntPtr.Zero || ProcessId(owner) != expectedOwnerPid)
                throw new InvalidOperationException("CLIPBOARD_OWNER_NOT_TARGET_WECHAT");
            var handle = GetClipboardData(13); // CF_UNICODETEXT
            if (handle == IntPtr.Zero) throw new InvalidOperationException("CLIPBOARD_NOT_UNICODE_TEXT");
            var pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("CLIPBOARD_LOCK_FAILED");
            try { return Marshal.PtrToStringUni(pointer); }
            finally { GlobalUnlock(handle); }
        } finally { CloseClipboard(); }
    }
}
'@

try {
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop | Out-Null
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop | Out-Null
} catch {
    Note 'COLLECT_FAILED: UIA_OR_WIN32_UNAVAILABLE'
    Note 'COLLECT_STAGE: INITIALIZE'
    exit 1
}

if ($SelfTest) {
    try { Note (Run-SelfTest); exit 0 }
    catch { Note ('SELFTEST_FAILED: ' + $_.Exception.Message); exit 1 }
}

$script:TargetPid = [uint32]0
$script:TargetHwnd = [IntPtr]::Zero
$script:Deadline = [DateTime]::UtcNow.AddSeconds($(if ($SingleArticleProbe) { 60 } else { 300 }))
$script:RunTabs = @()

function Activate-TargetWindow {
    $candidates = @(Get-Process WeChatAppEx -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ceq '微信' -and
            [IO.Path]::GetFileName($_.Path) -cne '' })
    if ($candidates.Count -ne 1) { Fail 'WECHAT_BROWSER_WINDOW_NOT_UNIQUE' }
    $target = [IntPtr]$candidates[0].MainWindowHandle
    if (-not [WeChatCollectorWin32]::ActivateWindow($target)) { Fail 'WECHAT_BROWSER_ACTIVATION_FAILED' }
    Start-Sleep -Milliseconds 200
    if ([WeChatCollectorWin32]::GetForegroundWindow() -ne $target) { Fail 'WECHAT_BROWSER_NOT_FOREGROUND' }
}

function Check-Deadline {
    [WeChatCollectorWin32]::CheckCancellation()
    if ([DateTime]::UtcNow -gt $script:Deadline) { Fail 'TIME_BUDGET_EXCEEDED' }
}

function Assert-TargetWindow {
    Check-Deadline
    $hwnd = [WeChatCollectorWin32]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { Fail 'NO_FOREGROUND_WINDOW' }
    if ($env:WECHAT_COLLECTOR_DEBUG -eq '1' -and [WeChatCollectorWin32]::WindowTitle($hwnd) -cne '微信') {
        $foregroundPid = [WeChatCollectorWin32]::ProcessId($hwnd)
        Note ('DEBUG_FOREGROUND_PROCESS: ' + $(if($foregroundPid){(Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue).ProcessName}else{'none'}))
    }
    if ([WeChatCollectorWin32]::WindowTitle($hwnd) -cne '微信') { Fail 'FOREGROUND_IS_NOT_WECHAT' }
    $ownerPid = [WeChatCollectorWin32]::ProcessId($hwnd)
    if ($ownerPid -eq 0) { Fail 'WECHAT_WINDOW_HAS_NO_PROCESS' }
    if ($script:TargetPid -ne 0 -and $ownerPid -ne $script:TargetPid) { Fail 'WECHAT_WINDOW_CHANGED' }
    $process = Get-Process -Id $ownerPid -ErrorAction Stop
    if ([IO.Path]::GetFileName($process.Path) -cne 'WeChatAppEx.exe') { Fail 'FOREGROUND_PROCESS_IS_NOT_WECHATAPPEX' }
    if ($script:TargetHwnd -ne [IntPtr]::Zero -and $hwnd -ne $script:TargetHwnd) { Fail 'WECHAT_HWND_CHANGED' }
    $script:TargetPid = $ownerPid
    $script:TargetHwnd = $hwnd
    return [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
}

function Is-Visible($Element) {
    if ($null -eq $Element) { return $false }
    try {
        $current = $Element.Current
        $r = $current.BoundingRectangle
        return (-not $current.IsOffscreen) -and $r.Width -gt 1 -and $r.Height -gt 1
    } catch { return $false }
}

function Find-Control($Root, $Type, [string]$Name, [string]$AutomationId = '', [bool]$VisibleOnly = $true) {
    $typeCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)
    $items = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $typeCondition)
    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $items) {
        if ($VisibleOnly -and -not (Is-Visible $item)) { continue }
        $current = $item.Current
        if ($Name -ne '' -and $current.Name -cne $Name) { continue }
        if ($AutomationId -ne '' -and $current.AutomationId -cne $AutomationId) { continue }
        $matches.Add($item)
    }
    return $matches.ToArray()
}

function One-Control($Root, $Type, [string]$Name, [string]$AutomationId, [string]$Code, [bool]$VisibleOnly = $true) {
    $items = @(Find-Control $Root $Type $Name $AutomationId $VisibleOnly)
    if ($items.Count -ne 1) { Fail $Code }
    return $items[0]
}

function One-AutomationId($Root, [string]$AutomationId, [string]$Code) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId)
    $items = @($Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
    if ($items.Count -ne 1) { Fail $Code }
    return $items[0]
}

function Get-HomeContext {
    $window = Assert-TargetWindow
    $document = One-Control $window ([System.Windows.Automation.ControlType]::Document) $MpName '' 'TARGET_ACCOUNT_DOCUMENT_NOT_ACTIVE'
    $app = One-Control $document ([System.Windows.Automation.ControlType]::Group) '' 'app' 'ACCOUNT_APP_GROUP_NOT_FOUND'
    $null = One-Control $app ([System.Windows.Automation.ControlType]::Text) $MpName '' 'TARGET_ACCOUNT_LABEL_NOT_FOUND' $false
    $articleLink = One-Control $app ([System.Windows.Automation.ControlType]::Hyperlink) '文章' '' 'ARTICLE_TAB_NOT_FOUND' $false
    return [pscustomobject]@{ Window = $window; Document = $document; App = $app; ArticleLink = $articleLink }
}

function Get-ArticleContext([string]$Title) {
    $window = Assert-TargetWindow
    $documents = @(Find-Control $window ([System.Windows.Automation.ControlType]::Document) '' '' |
        Where-Object { (Normalize-Title $_.Current.Name) -ceq (Normalize-Title $Title) })
    if ($documents.Count -ne 1) { Fail 'ARTICLE_DOCUMENT_NOT_ACTIVE' }
    $document = $documents[0]
    $heading = One-AutomationId $document 'activity-name' 'ARTICLE_TITLE_ID_NOT_FOUND'
    if ((Normalize-Title $heading.Current.Name) -cne (Normalize-Title $Title)) { Fail 'ARTICLE_TITLE_MISMATCH' }
    $publisher = One-AutomationId $document 'js_name' 'ARTICLE_PUBLISHER_NOT_FOUND'
    if ($publisher.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or $publisher.Current.Name -cne $MpName) { Fail 'ARTICLE_PUBLISHER_MISMATCH' }
    $body = One-AutomationId $document 'js_content' 'ARTICLE_BODY_GROUP_NOT_FOUND'
    if ($body.Current.ControlType -ne [System.Windows.Automation.ControlType]::Group) { Fail 'ARTICLE_BODY_GROUP_MISMATCH' }
    return [pscustomobject]@{ Window = $window; Document = $document }
}

function Wait-Article([string]$Title, [int]$TimeoutMs = 8000) {
    $until = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $lastCode = ''
    while ([DateTime]::UtcNow -lt $until) {
        Check-Deadline
        try { return Get-ArticleContext $Title } catch {
            $lastCode = Get-FailureCode $_
            if ($lastCode -in @('USER_CANCELLED', 'TIME_BUDGET_EXCEEDED', 'FOREGROUND_IS_NOT_WECHAT', 'WECHAT_HWND_CHANGED', 'WECHAT_WINDOW_CHANGED')) { throw }
            Start-Sleep -Milliseconds 150
        }
    }
    if ($env:WECHAT_COLLECTOR_DEBUG -eq '1') { Note ('DEBUG_ARTICLE: ' + $lastCode) }
    Fail 'ARTICLE_DID_NOT_OPEN_OR_VALIDATE'
}

function Wait-Home([int]$TimeoutMs = 5000) {
    $until = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $until) {
        Check-Deadline
        try { return Get-HomeContext } catch {
            if ((Get-FailureCode $_) -in @('USER_CANCELLED', 'TIME_BUDGET_EXCEEDED', 'FOREGROUND_IS_NOT_WECHAT', 'WECHAT_HWND_CHANGED', 'WECHAT_WINDOW_CHANGED')) { throw }
            Start-Sleep -Milliseconds 150
        }
    }
    Fail 'TARGET_HOME_NOT_RESTORED'
}

function Assert-PointOwned([System.Windows.Rect]$Rect) {
    $window = Assert-TargetWindow
    $windowRect = $window.Current.BoundingRectangle
    if ($Rect.Width -le 1 -or $Rect.Height -le 1) { Fail 'ELEMENT_HAS_NO_CLICKABLE_RECT' }
    $x = [int][Math]::Round($Rect.Left + $Rect.Width / 2)
    $y = [int][Math]::Round($Rect.Top + $Rect.Height / 2)
    if (-not $windowRect.Contains([double]$x, [double]$y)) { Fail 'ELEMENT_OUTSIDE_WECHAT_WINDOW' }
    if ([WeChatCollectorWin32]::ProcessIdAt($x, $y) -ne $script:TargetPid) { Fail 'CLICK_POINT_NOT_OWNED_BY_WECHAT' }
    return [pscustomobject]@{ X = $x; Y = $y }
}

function Click-Element($Element) {
    if (-not (Is-Visible $Element)) { Fail 'TARGET_ELEMENT_NOT_VISIBLE' }
    if ([uint32]$Element.Current.ProcessId -ne $script:TargetPid) { Fail 'TARGET_ELEMENT_PROCESS_MISMATCH' }
    $window = Assert-TargetWindow
    if (-not $window.Current.BoundingRectangle.Contains($Element.Current.BoundingRectangle)) { Fail 'TARGET_ELEMENT_NOT_FULLY_VISIBLE' }
    $point = Assert-PointOwned $Element.Current.BoundingRectangle
    $null = Assert-TargetWindow
    [WeChatCollectorWin32]::Click($point.X, $point.Y)
}

function Activate-Element($Element) {
    if (-not (Is-Visible $Element)) { Fail 'TARGET_ELEMENT_NOT_VISIBLE' }
    if ([uint32]$Element.Current.ProcessId -ne $script:TargetPid) { Fail 'TARGET_ELEMENT_PROCESS_MISMATCH' }
    $pattern = $null
    $supported = $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)
    if ($supported -and $null -ne $pattern) {
        $null = Assert-TargetWindow
        # Invoke 失败后不能再点击：第一次动作可能已经成功。
        $pattern.Invoke()
        return
    }
    Click-Element $Element
}

function Switch-FirstTab {
    $null = Assert-TargetWindow
    [WeChatCollectorWin32]::FirstTab()
    return Wait-Home
}

function Get-TabSnapshot {
    $window = Assert-TargetWindow
    $tabs = @(Find-Control $window ([System.Windows.Automation.ControlType]::TabItem) '' '' $false)
    $script:Diagnostic = @{ tabItems = $tabs.Count }
    if ($tabs.Count -eq 0) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    $snapshot = @()
    foreach ($tab in $tabs) {
        $pattern = $null
        if (-not $tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
            Fail 'TAB_OWNERSHIP_UNVERIFIED'
        }
        $snapshot += [pscustomobject]@{
            Id = ($tab.GetRuntimeId() -join '-')
            Selected = [bool]$pattern.Current.IsSelected
        }
    }
    if (@($snapshot | Where-Object Selected).Count -ne 1 -or
        @($snapshot.Id | Sort-Object -Unique).Count -ne $snapshot.Count) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    return $snapshot
}

function Assert-SameTabs($Expected, $Actual) {
    if ($Expected.Count -ne $Actual.Count) { Fail 'TAB_SET_CHANGED' }
    foreach ($tab in $Expected) {
        $match = @($Actual | Where-Object { $_.Id -ceq $tab.Id })
        if ($match.Count -ne 1 -or $match[0].Selected -ne $tab.Selected) { Fail 'TAB_SET_CHANGED' }
    }
}

function Get-OwnedTabId($Before, $After) {
    if ($After.Count -ne $Before.Count + 1) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    foreach ($tab in $Before) {
        if (@($After | Where-Object { $_.Id -ceq $tab.Id }).Count -ne 1) { Fail 'TAB_SET_CHANGED' }
    }
    $added = @($After | Where-Object { $_.Id -cnotin @($Before.Id) })
    if ($added.Count -ne 1 -or -not $added[0].Selected -or
        @($After | Where-Object Selected).Count -ne 1) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    return $added[0].Id
}

function Wait-OwnedTab($Before) {
    $until = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Check-Deadline
        $after = @(Get-TabSnapshot)
        if ($after.Count -gt $Before.Count) { return Get-OwnedTabId $Before $after }
        Assert-SameTabs $Before $after
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $until)
    Fail 'TAB_OWNERSHIP_UNVERIFIED'
}

function Close-OwnedTab($Before, [string]$OwnedId) {
    Set-Stage 'CLOSE_ARTICLE'
    $after = @(Get-TabSnapshot)
    if ((Get-OwnedTabId $Before $after) -cne $OwnedId) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    $null = Assert-TargetWindow
    [WeChatCollectorWin32]::CloseCurrentTab()
    $null = Wait-Home
    Assert-SameTabs $Before @(Get-TabSnapshot)
}

function Get-HomeTopSignature($ProfilePage) {
    # Ctrl+Home 可能作用于标签栏；同时验证页面首部节点的真实位置。
    $label = One-Control $ProfilePage.App ([System.Windows.Automation.ControlType]::Text) $MpName '' 'TOP_OF_PAGE_UNVERIFIED' $true
    $windowRect = $ProfilePage.Window.Current.BoundingRectangle
    $linkRect = $ProfilePage.ArticleLink.Current.BoundingRectangle
    $labelRect = $label.Current.BoundingRectangle
    if (-not (Is-Visible $ProfilePage.ArticleLink) -or $labelRect.Bottom -gt $linkRect.Top -or
        -not $windowRect.Contains($labelRect) -or -not $windowRect.Contains($linkRect)) { Fail 'TOP_OF_PAGE_UNVERIFIED' }
    $texts = @(Get-TextChildren $ProfilePage.App)
    $first = @($texts | Where-Object { (Test-DateText $_.Current.Name) -or $_.Current.Name -ceq '置顶' } | Select-Object -First 1)
    if ($first.Count -ne 1 -or -not (Is-Visible $first[0]) -or
        $first[0].Current.BoundingRectangle.Top -lt $linkRect.Bottom -or
        -not $windowRect.Contains($first[0].Current.BoundingRectangle)) { Fail 'TOP_OF_PAGE_UNVERIFIED' }
    return (($first[0].GetRuntimeId() -join '-') + ':' + [int]$first[0].Current.BoundingRectangle.Top)
}

function Reset-HomeTop($ProfilePage) {
    Set-Stage 'RESET_HOME_TOP'
    $null = Assert-TargetWindow
    # 找到列表自身的滚动容器；不依赖可能仍在标签栏的键盘焦点。
    $first = @(Get-TextChildren $ProfilePage.App | Where-Object {
        (Test-DateText $_.Current.Name) -or $_.Current.Name -ceq '置顶'
    } | Select-Object -First 1)
    if ($first.Count -ne 1) { Fail 'TOP_OF_PAGE_UNVERIFIED' }
    $owner = Get-Parent $first[0]
    $scroll = $null
    $script:Diagnostic = @{ scrollOwnersExamined = 0; scrollPatternFound = $false }
    for ($depth = 0; $depth -lt 16 -and $null -ne $owner; $depth++) {
        $script:Diagnostic.scrollOwnersExamined = $depth + 1
        $candidate = $null
        if ($owner.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$candidate) -and
            $candidate.Current.VerticallyScrollable) { $scroll = $candidate; break }
        if ($owner.Equals($ProfilePage.Document)) { break }
        $owner = Get-Parent $owner
    }
    if ($null -eq $scroll) { Fail 'TOP_OF_PAGE_UNVERIFIED' }
    $script:Diagnostic.scrollPatternFound = $true
    $null = Assert-TargetWindow
    $scroll.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, 0)
    Start-Sleep -Milliseconds 200
    $current = Wait-Home
    $signature = Get-HomeTopSignature $current
    Start-Sleep -Milliseconds 150
    $current = Get-HomeContext
    if ([Math]::Abs($scroll.Current.VerticalScrollPercent) -gt 0.01 -or
        (Get-HomeTopSignature $current) -cne $signature) { Fail 'TOP_OF_PAGE_UNVERIFIED' }
    Assert-SameTabs $script:RunTabs @(Get-TabSnapshot)
    return $current
}

function Get-Parent($Element) {
    try { return [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($Element) }
    catch { return $null }
}

function Get-TextChildren($Root) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    return $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Has-Text($Root, [scriptblock]$Predicate) {
    foreach ($text in (Get-TextChildren $Root)) {
        if (& $Predicate $text.Current.Name) { return $true }
    }
    return $false
}

function Get-CardGroup($TitleElement, $App, [bool]$Pinned = $false) {
    $parent = Get-Parent $TitleElement
    $script:Diagnostic = @{ ancestors = 0; titleCount = 0; hasMetric = $false; pinned = $Pinned }
    for ($depth = 0; $depth -lt 12 -and $null -ne $parent; $depth++) {
        if ($parent.Equals($App)) { break }
        if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group) {
            $titles = [System.Collections.Generic.List[object]]::new()
            $metric = $false
            foreach ($text in (Get-TextChildren $parent)) {
                $name = [string]$text.Current.Name
                if (Test-MetricText $name) { $metric = $true }
                elseif (-not (Test-NonTitleText $name)) { $titles.Add($text) }
            }
            $script:Diagnostic = @{ ancestors = $depth + 1; titleCount = $titles.Count; hasMetric = $metric; pinned = $Pinned }
            # 结构判断包含屏外节点；可点击性在点击前另行验证。
            # 置顶段有明确边界，本身不一定显示阅读数字。
            if (($metric -or $Pinned) -and $titles.Count -eq 1) {
                $only = $titles[0]
                if (($only.GetRuntimeId() -join '-') -ceq ($TitleElement.GetRuntimeId() -join '-')) { return $parent }
            }
        }
        $parent = Get-Parent $parent
    }
    return $null
}

function Test-PinnedCard($CardGroup, $App) {
    $parent = $CardGroup
    for ($depth = 0; $depth -lt 7 -and $null -ne $parent; $depth++) {
        if ($parent.Equals($App)) { break }
        if (Has-Text $parent { param($text) $text -ceq '置顶' }) { return $true }
        $previous = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetPreviousSibling($parent)
        if ($null -ne $previous -and $previous.Current.Name -ceq '置顶') { return $true }
        $parent = Get-Parent $parent
    }
    return $false
}

function Resolve-CardDate($CardGroup) {
    # The observed article list presents each date Text immediately before its card Group.
    # A proximity guess could attach a different article's date, so any other tree fails.
    try { $previous = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetPreviousSibling($CardGroup) }
    catch { Fail 'CARD_DATE_SIBLING_UNAVAILABLE' }
    if ($null -eq $previous -or $previous.Current.ControlType -ne [System.Windows.Automation.ControlType]::Text) {
        Fail 'CARD_DATE_NOT_PREVIOUS_SIBLING'
    }
    $date = ([string]$previous.Current.Name).Trim()
    if (-not (Test-DateText $date)) { Fail 'CARD_DATE_NOT_RECOGNIZED' }
    return $date
}

function Get-VisibleCards($ProfilePage) {
    $linkRect = $ProfilePage.ArticleLink.Current.BoundingRectangle
    $candidateTexts = Get-TextChildren $ProfilePage.App
    $cards = [System.Collections.Generic.List[object]]::new()
    $seenRects = [System.Collections.Generic.HashSet[string]]::new()
    $inPinnedSection = $false
    $currentDate = ''
    $datePending = $false
    $windowRect = $ProfilePage.Window.Current.BoundingRectangle
    foreach ($item in $candidateTexts) {
        $name = [string]$item.Current.Name
        $rect = $item.Current.BoundingRectangle
        if ($name -ceq '置顶') { $inPinnedSection = $true; continue }
        if ($inPinnedSection -and (Test-DateText $name)) { $inPinnedSection = $false }
        if ($inPinnedSection) { continue }
        if (Test-DateText $name) { $currentDate = $name; $datePending = $true; continue }
        if ($name -match '^(?:余下\s*\d+\s*篇|展开|更多文章)$') { Fail 'COLLAPSED_ARTICLE_GROUP_UNSUPPORTED' }
        if ($name -match '^\d+个内容$') {
            Fail 'COLLAPSED_ARTICLE_GROUP_UNSUPPORTED'
        }
        if ($rect.Top -le $linkRect.Bottom -or (Test-NonTitleText $name)) { continue }
        if (-not $datePending -and [string]::IsNullOrWhiteSpace($currentDate)) { Fail 'CARD_DATE_NOT_PRECEDING_TITLE' }
        # Chromium can report IsOffscreen=false when only a few pixels of the title touch the viewport.
        if (-not (Is-Visible $item) -or $rect.Bottom -gt ($windowRect.Bottom - 40) -or
            -not $windowRect.Contains($rect.Left + $rect.Width / 2, $rect.Top + $rect.Height / 2)) { continue }
        $group = Get-CardGroup $item $ProfilePage.App
        if ($null -eq $group) {
            # A stray text after the article tab may be an unsupported card. Never silently skip it.
            Fail 'AMBIGUOUS_ARTICLE_TEXT_OR_CARD'
        }
        $date = $currentDate
        $key = $name + '|' + [int]$rect.Left + '|' + [int]$rect.Top
        if (-not $seenRects.Add($key)) { continue }
        $cards.Add([pscustomobject]@{ Title = $name.Trim(); Date = $date; Element = $item; Rect = $rect; RuntimeId = ($item.GetRuntimeId() -join '-') })
    }
    return $cards.ToArray() | Sort-Object @{ Expression = { $_.Rect.Top } }, @{ Expression = { $_.Rect.Left } }
}

function Get-PinnedItems($ProfilePage, [int]$ExpandAttempts = 0) {
    $texts = @(Get-TextChildren $ProfilePage.App)
    $start = -1
    $end = -1
    for ($index = 0; $index -lt $texts.Count; $index++) {
        $name = [string]$texts[$index].Current.Name
        if ($name -ceq '置顶') {
            if ($start -ge 0) { Fail 'PINNED_SECTION_AMBIGUOUS' }
            $start = $index
        } elseif ($start -ge 0 -and (Test-DateText $name)) {
            $end = $index
            break
        }
    }
    if ($start -lt 0) { return @() }
    if ($end -le $start + 1) { Fail 'PINNED_SECTION_UNVERIFIED' }
    $collapsed = @($texts[($start + 1)..($end - 1)] | Where-Object { $_.Current.Name -match '^\d+个内容$' })
    if ($collapsed.Count -gt 1) { Fail 'PINNED_GROUPS_AMBIGUOUS' }
    if ($collapsed.Count -eq 1) {
        if ($ExpandAttempts -ge 1) { Fail 'PINNED_GROUP_DID_NOT_EXPAND' }
        $count = [int]([regex]::Match($collapsed[0].Current.Name, '^\d+').Value)
        if ($count -gt 5) { Fail 'PINNED_GROUP_TOO_LARGE' }
        Click-Element $collapsed[0]
        Start-Sleep -Milliseconds 250
        return Get-PinnedItems (Get-HomeContext) ($ExpandAttempts + 1)
    }
    $items = [System.Collections.Generic.List[object]]::new()
    for ($index = $start + 1; $index -lt $end; $index++) {
        $item = $texts[$index]
        $name = [string]$item.Current.Name
        if (Test-NonTitleText $name) { continue }
        if ($null -eq (Get-CardGroup $item $ProfilePage.App $true)) { Fail 'PINNED_CARD_UNVERIFIED' }
        $items.Add([pscustomobject]@{ Title = $name.Trim(); Element = $item; RuntimeId = ($item.GetRuntimeId() -join '-') })
    }
    if ($items.Count -eq 0 -or $items.Count -gt 5) { Fail 'PINNED_CARD_COUNT_UNVERIFIED' }
    return $items.ToArray()
}

function Wait-CopyMenuItem([int]$TimeoutMs = 3000) {
    $until = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $until) {
        $window = Assert-TargetWindow
        $items = @(Find-Control $window ([System.Windows.Automation.ControlType]::MenuItem) '复制链接')
        if ($items.Count -eq 1) { return $items[0] }
        if ($items.Count -gt 1) { Fail 'COPY_MENU_ITEM_AMBIGUOUS' }
        Start-Sleep -Milliseconds 100
    }
    Fail 'COPY_MENU_ITEM_NOT_FOUND'
}

function Copy-OfficialShortUrl($Article, $TabBaseline, [string]$OwnedId) {
    if ((Get-OwnedTabId $TabBaseline @(Get-TabSnapshot)) -cne $OwnedId) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    $more = One-Control $Article.Window ([System.Windows.Automation.ControlType]::Button) '更多' '' 'MORE_BUTTON_NOT_FOUND'
    Activate-Element $more
    $item = Wait-CopyMenuItem
    $before = [WeChatCollectorWin32]::GetClipboardSequenceNumber()
    if ($before -eq 0) { Fail 'CLIPBOARD_SEQUENCE_UNAVAILABLE' }
    if ((Get-OwnedTabId $TabBaseline @(Get-TabSnapshot)) -cne $OwnedId) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    Activate-Element $item
    $until = [DateTime]::UtcNow.AddSeconds(4)
    $after = $before
    while ([DateTime]::UtcNow -lt $until) {
        $null = Assert-TargetWindow
        $after = [WeChatCollectorWin32]::GetClipboardSequenceNumber()
        if ($after -ne $before) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($after -eq $before) { Fail 'COPY_DID_NOT_CHANGE_CLIPBOARD' }
    if ((Get-OwnedTabId $TabBaseline @(Get-TabSnapshot)) -cne $OwnedId) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    $owner = [WeChatCollectorWin32]::GetClipboardOwner()
    if ($owner -eq [IntPtr]::Zero -or [WeChatCollectorWin32]::ProcessId($owner) -ne $script:TargetPid) {
        Fail 'CLIPBOARD_OWNER_NOT_TARGET_WECHAT'
    }
    $raw = [WeChatCollectorWin32]::ReadClipboardUnicodeOnce($after, $script:TargetPid)
    if ([WeChatCollectorWin32]::GetClipboardSequenceNumber() -ne $after) { Fail 'CLIPBOARD_CHANGED_DURING_READ' }
    return Parse-ShortUrl $raw
}

function Copy-CardAndClose($Element, [string]$Title) {
    Set-Stage 'OPEN_ARTICLE'
    $null = Get-HomeContext
    $before = @(Get-TabSnapshot)
    Assert-SameTabs $script:RunTabs $before
    $ownedId = ''
    $shortUrl = ''
    $primaryError = $null
    $failedStage = ''
    $failedDiagnostic = @{}
    try {
        Click-Element $Element
        $ownedId = Wait-OwnedTab $before
        $article = Wait-Article $Title
        if ((Get-OwnedTabId $before @(Get-TabSnapshot)) -cne $ownedId) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
        Set-Stage 'COPY_LINK'
        $shortUrl = Copy-OfficialShortUrl $article $before $ownedId
    } catch {
        $primaryError = $_
        $failedStage = $script:Stage
        $failedDiagnostic = @{} + $script:Diagnostic
    } finally {
        # Esc/焦点丢失后不继续输入。其余失败也只关闭有前后差分证明的本次标签。
        $interrupted = $null -ne $primaryError -and (Get-FailureCode $primaryError) -in @(
            'USER_CANCELLED', 'FOREGROUND_IS_NOT_WECHAT', 'NO_FOREGROUND_WINDOW',
            'FOREGROUND_PROCESS_IS_NOT_WECHATAPPEX', 'WECHAT_HWND_CHANGED', 'WECHAT_WINDOW_CHANGED', 'TAB_SET_CHANGED'
        )
        if ($ownedId -and -not $interrupted) {
            try { Close-OwnedTab $before $ownedId } catch {
                if ($null -eq $primaryError) { $primaryError = $_; $failedStage = $script:Stage; $failedDiagnostic = @{} + $script:Diagnostic }
                else { Note ('COLLECT_CLEANUP: ' + (Get-FailureCode $_)) }
            }
        }
    }
    if ($null -ne $primaryError) { $script:Stage = $failedStage; $script:Diagnostic = $failedDiagnostic; throw $primaryError }
    return $shortUrl
}

function Register-CardObservation($Seen, $Card) {
    $signature = $Card.Date + '|' + (Normalize-Title $Card.Title)
    if ($Seen.ContainsKey($Card.RuntimeId)) {
        if ($Seen[$Card.RuntimeId] -cne $signature) { Fail 'CARD_ID_REUSED' }
        return $false
    }
    $Seen[$Card.RuntimeId] = $signature
    return $true
}

function Scroll-ArticleList($ProfilePage) {
    $rect = $ProfilePage.ArticleLink.Current.BoundingRectangle
    $windowRect = $ProfilePage.Window.Current.BoundingRectangle
    $x = [int][Math]::Round($rect.Left + $rect.Width / 2)
    $y = [int][Math]::Round($windowRect.Top + $windowRect.Height * 0.72)
    if (-not $windowRect.Contains([double]$x, [double]$y)) { Fail 'SCROLL_POINT_OUTSIDE_WECHAT' }
    $null = Assert-TargetWindow
    if ([WeChatCollectorWin32]::ProcessIdAt($x, $y) -ne $script:TargetPid) { Fail 'SCROLL_POINT_NOT_OWNED_BY_WECHAT' }
    [WeChatCollectorWin32]::WheelDown($x, $y)
    Start-Sleep -Milliseconds 250
}

function Collect-Articles {
    Set-Stage 'VERIFY_HOME'
    Activate-TargetWindow
    $profilePage = Get-HomeContext
    $script:RunTabs = @(Get-TabSnapshot)
    $profilePage = Reset-HomeTop $profilePage
    Set-Stage 'SCAN_PINNED'
    $pinnedCards = @(Get-PinnedItems $profilePage)
    if ($SingleArticleProbe) {
        $probeCard = if ($pinnedCards.Count) { $pinnedCards[0] } else { @(Get-VisibleCards $profilePage) | Select-Object -First 1 }
        if ($null -eq $probeCard) { Fail 'PROBE_CARD_NOT_VISIBLE' }
        $url = Copy-CardAndClose $probeCard.Element $probeCard.Title
        return [pscustomobject]@{ protocolVersion = 2; probeOnly = $true; account = $MpName; mpId = $MpId; source = 'desktop-wechat'; articles = @([pscustomobject]@{ rank = 1; title = $probeCard.Title; shortUrl = $url }); pinnedArticles = @() }
    }
    $pinnedArticles = [System.Collections.Generic.List[object]]::new()
    foreach ($pinnedCard in $pinnedCards) {
        Set-Stage 'SCAN_PINNED'
        $profilePage = Get-HomeContext
        $candidate = @((Get-PinnedItems $profilePage) | Where-Object { $_.RuntimeId -ceq $pinnedCard.RuntimeId -and $_.Title -ceq $pinnedCard.Title })
        if ($candidate.Count -ne 1) { Fail 'PINNED_CARD_CHANGED' }
        $shortUrl = Copy-CardAndClose $candidate[0].Element $pinnedCard.Title
        $pinnedArticles.Add([pscustomobject]@{ title = $pinnedCard.Title; shortUrl = $shortUrl })
    }
    $seenCards = [System.Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $seenUrls = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $articles = [System.Collections.Generic.List[object]]::new()
    $stalledScrolls = 0
    $openAttempts = 0
    while ($articles.Count -lt $Limit) {
        Set-Stage 'SCAN_REGULAR'
        $profilePage = Get-HomeContext
        $cards = @(Get-VisibleCards $profilePage)
        $visitedThisView = $false
        foreach ($card in $cards) {
            if (-not (Register-CardObservation $seenCards $card)) { continue }
            $visitedThisView = $true
            $openAttempts++
            if ($openAttempts -gt $Limit + 5) { Fail 'CARD_SEQUENCE_CHANGED' }
            $profilePage = Get-HomeContext
            if (-not (Is-Visible $card.Element)) { Fail 'CARD_DISAPPEARED_BEFORE_CLICK' }
            $shortUrl = Copy-CardAndClose $card.Element $card.Title
            if (-not $seenUrls.Add($shortUrl)) { Fail 'CARD_SEQUENCE_CHANGED' }
            else {
                $articles.Add([pscustomobject]@{
                        rank = $articles.Count + 1
                        title = $card.Title
                        shortUrl = $shortUrl
                    })
            }
            Start-Sleep -Milliseconds 500
            break
        }
        if ($articles.Count -ge $Limit) { break }
        if ($visitedThisView) { $stalledScrolls = 0; continue }
        $stalledScrolls++
        if ($stalledScrolls -ge 4) { Fail 'FEWER_THAN_REQUESTED_UNIQUE_ARTICLES' }
        $profilePage = Get-HomeContext
        Set-Stage 'SCROLL_LIST'
        Scroll-ArticleList $profilePage
    }
    if ($articles.Count -ne $Limit) { Fail 'ARTICLE_COUNT_MISMATCH' }
    return [pscustomobject]@{
        protocolVersion = 2
        account = $MpName
        mpId = $MpId
        source = 'desktop-wechat'
        articles = $articles.ToArray()
        pinnedArticles = $pinnedArticles.ToArray()
    }
}

$runMutex = [Threading.Mutex]::new($false, 'Local\WeWeRssDesktopCollector')
$ownsMutex = $false
$pausePath = $null
try {
    try { $ownsMutex = $runMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { Fail 'GLOBAL_COLLECTOR_BUSY' }
    # 版本化应用必须共用一份暂停状态；源码运行仍使用原位置。
    $pausePath = if ($env:WECHAT_DESKTOP_PAUSE_FILE) {
        if (-not [IO.Path]::IsPathFullyQualified($env:WECHAT_DESKTOP_PAUSE_FILE) -or
            [IO.Path]::GetFileName($env:WECHAT_DESKTOP_PAUSE_FILE) -cne '.paused') {
            Fail 'INVALID_PAUSE_FILE'
        }
        [IO.Path]::GetFullPath($env:WECHAT_DESKTOP_PAUSE_FILE)
    } else { Join-Path $PSScriptRoot '.paused' }
    if (Test-Path -LiteralPath $pausePath) {
        if (-not $ResumeAfterUserConsent) { Fail 'USER_PAUSED' }
        Remove-Item -LiteralPath $pausePath
    }
    [WeChatCollectorWin32]::StartCancellationWatch()
    $result = Collect-Articles
    Check-Deadline
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
    exit 0
} catch {
    if ($env:WECHAT_COLLECTOR_DEBUG -eq '1') {
        Note ('DEBUG: ' + $_.Exception.GetType().Name + ' at ' + $_.InvocationInfo.ScriptLineNumber + ' stack ' + $_.ScriptStackTrace)
        if ($null -ne $_.Exception.InnerException -and $_.Exception.InnerException.Message -match '^[A-Z][A-Z0-9_]+$') {
            Note ('DEBUG_INNER: ' + $_.Exception.InnerException.Message)
        }
    }
    # The exception text is deliberately limited to our own symbolic failure codes.
    $message = Get-FailureCode $_
    if ($message -ceq 'USER_CANCELLED' -or [WeChatCollectorWin32]::CancellationRequested) {
        try { [IO.File]::WriteAllText($pausePath, 'USER_CANCELLED', [Text.UTF8Encoding]::new($false)) }
        catch { Note 'COLLECT_CLEANUP: PAUSE_STATE_WRITE_FAILED' }
    }
    Note ('COLLECT_FAILED: ' + $message)
    Note ('COLLECT_STAGE: ' + $script:Stage)
    Note ('COLLECT_DIAGNOSTIC: ' + ($script:Diagnostic | ConvertTo-Json -Compress))
    exit 1
} finally {
    [WeChatCollectorWin32]::StopCancellationWatch()
    if ($ownsMutex) { $runMutex.ReleaseMutex() }
    $runMutex.Dispose()
}
