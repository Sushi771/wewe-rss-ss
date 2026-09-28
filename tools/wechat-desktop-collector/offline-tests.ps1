param(
    [string]$CollectorPath = (Join-Path $PSScriptRoot 'collect.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Read definitions from one source snapshot. Never dot-source collect.ps1: its
# top-level code compiles Win32 helpers, activates WeChat, and starts collection.
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $CollectorPath).Path)
$sourceHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($source))).ToLowerInvariant()
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, $CollectorPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'COLLECTOR_PARSE_FAILED' }

$functionNames = @(
    'Fail', 'Set-Stage', 'Get-FailureCode', 'Normalize-Title',
    'Test-DateText', 'Test-MetricText', 'Test-NonTitleText',
    'Get-CardGroup', 'Get-VisibleCards', 'Assert-SameTabs', 'Get-OwnedTabId',
    'Register-CardObservation', 'Copy-CardAndClose'
)
$allowedCommands = $functionNames + @(
    'Get-Parent', 'Get-TextChildren', 'Is-Visible', 'Get-HomeContext',
    'Get-TabSnapshot', 'Click-Element', 'Wait-OwnedTab', 'Wait-Article',
    'Copy-OfficialShortUrl', 'Close-OwnedTab', 'Note', 'Sort-Object', 'Where-Object'
)
$allowedStaticTypes = @(
    'regex', 'string', 'System.Collections.Generic.HashSet[string]',
    'System.Collections.Generic.List[object]', 'System.InvalidOperationException',
    'System.Windows.Automation.ControlType', 'Text.NormalizationForm'
)
foreach ($name in $functionNames) {
    $definitions = @($ast.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
            }, $false))
    if ($definitions.Count -ne 1) { throw ('TEST_FUNCTION_NOT_UNIQUE: ' + $name) }
    # Future production edits must not turn a formerly pure tested function into
    # a direct UI or native call. Unknown commands/types fail before import.
    foreach ($command in $definitions[0].FindAll({
                param($node)
                $node -is [Management.Automation.Language.CommandAst]
            }, $true)) {
        if ($command.GetCommandName() -cnotin $allowedCommands) {
            throw ('UNSAFE_OFFLINE_FUNCTION_COMMAND: ' + $name + ' -> ' + $command.GetCommandName())
        }
    }
    foreach ($type in $definitions[0].FindAll({
                param($node)
                $node -is [Management.Automation.Language.TypeExpressionAst]
            }, $true)) {
        if ($type.TypeName.FullName -cnotin $allowedStaticTypes) {
            throw ('UNSAFE_OFFLINE_FUNCTION_TYPE: ' + $name + ' -> ' + $type.TypeName.FullName)
        }
    }
    # Only a FunctionDefinitionAst is evaluated; neither the native source string
    # nor any statement outside these explicitly selected definitions is loaded.
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}

# These assemblies provide ControlType values for fake elements only.
# No AutomationElement, RootElement, FromHandle, TreeWalker, or pattern method
# is invoked against the desktop by this test suite.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if ($null -ne ('WeChatCollectorWin32' -as [type])) { throw 'NATIVE_HELPER_MUST_NOT_BE_LOADED' }

$script:results = [Collections.Generic.List[object]]::new()
$script:Stage = 'OFFLINE_TEST'
$script:Diagnostic = @{}
$script:Flow = $null

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('ASSERTION_FAILED: ' + $Message) }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -cne $Actual) {
        throw ('ASSERTION_FAILED: ' + $Message + '; expected=' + $Expected + '; actual=' + $Actual)
    }
}

function Assert-Throws([string]$Code, [scriptblock]$Action) {
    $caught = $null
    try { $null = & $Action } catch { $caught = $_ }
    if ($null -eq $caught) { throw ('ASSERTION_FAILED: expected ' + $Code + ', but action succeeded') }
    Assert-Equal $Code (Get-FailureCode $caught) 'Wrong error code'
}

function Test-Case([string]$Name, [scriptblock]$Action) {
    try {
        $null = & $Action
        $script:results.Add([pscustomobject]@{ name = $Name; passed = $true })
    } catch {
        $script:results.Add([pscustomobject]@{ name = $Name; passed = $false; error = $_.Exception.Message })
    }
}

function New-FakeRect([double]$Left, [double]$Top, [double]$Width, [double]$Height) {
    $rect = [pscustomobject]@{
        Left = $Left; Top = $Top; Width = $Width; Height = $Height
        Right = $Left + $Width; Bottom = $Top + $Height
    }
    $rect | Add-Member -MemberType ScriptMethod -Name Contains -Value {
        param([double]$X, [double]$Y)
        return $X -ge $this.Left -and $X -le $this.Right -and $Y -ge $this.Top -and $Y -le $this.Bottom
    }
    return $rect
}

function New-FakeElement(
    [string]$Id,
    [string]$Name,
    $Type = [System.Windows.Automation.ControlType]::Text,
    [bool]$Visible = $true,
    $Rect = $null
) {
    if ($null -eq $Rect) { $Rect = New-FakeRect 100 200 300 24 }
    $element = [pscustomobject]@{
        Current = [pscustomobject]@{
            Name = $Name
            ControlType = $Type
            IsOffscreen = -not $Visible
            BoundingRectangle = $Rect
        }
        TestRuntimeId = @($Id)
        TestParent = $null
        TestTextChildren = @()
    }
    $element | Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value { return $this.TestRuntimeId }
    $element | Add-Member -MemberType ScriptMethod -Name Equals -Force -Value {
        param($Other)
        return $null -ne $Other -and ($this.GetRuntimeId() -join '-') -ceq ($Other.GetRuntimeId() -join '-')
    }
    return $element
}

# Mock every UI-dependent operation reachable from the imported card functions.
function Get-Parent($Element) { return $Element.TestParent }
function Get-TextChildren($Root) { return $Root.TestTextChildren }
function Is-Visible($Element) { return $null -ne $Element -and -not $Element.Current.IsOffscreen }

function New-CardFixture([bool]$Visible = $true, [bool]$WithMetric = $true) {
    $app = New-FakeElement 'app' '' ([System.Windows.Automation.ControlType]::Group)
    $group = New-FakeElement 'group' '' ([System.Windows.Automation.ControlType]::Group)
    $title = New-FakeElement 'title' '离线卡片标题' -Visible $Visible
    $group.TestParent = $app
    $title.TestParent = $group
    $group.TestTextChildren = @($title)
    if ($WithMetric) {
        $metric = New-FakeElement 'metric' '阅读 123' -Visible $Visible
        $metric.TestParent = $group
        $group.TestTextChildren += $metric
    }
    return [pscustomobject]@{ App = $app; Group = $group; Title = $title }
}

function New-Tab([string]$Id, [bool]$Selected) {
    return [pscustomobject]@{ Id = $Id; Selected = $Selected }
}

function New-BeforeTabs {
    # Home is deliberately not tab 1, and an unrelated user tab must survive.
    return @((New-Tab 'user-existing' $false), (New-Tab 'home' $true))
}

function New-AfterTabs {
    return @((New-Tab 'user-existing' $false), (New-Tab 'home' $false), (New-Tab 'owned-new' $true))
}

function Reset-Flow {
    $script:Stage = 'OFFLINE_TEST'
    $script:Diagnostic = @{}
    $script:RunTabs = @(New-BeforeTabs)
    $script:Flow = @{
        Tabs = @(New-BeforeTabs)
        AfterTabs = @(New-AfterTabs)
        Events = [Collections.Generic.List[string]]::new()
        Notes = [Collections.Generic.List[string]]::new()
        WaitError = ''
        OwnershipError = ''
        CopyError = ''
        CloseError = ''
        ClickError = ''
        CopyDiagnostic = @{}
        CloseDiagnostic = @{}
        Cancelled = $false
        FocusLost = $false
        FocusRecoversBeforeCleanup = $false
        SwitchBeforeCopy = $false
        CloseAttempts = 0
        Url = 'https://mp.weixin.qq.com/s/AAAAAAAAAAAAAAAAAAAAAA'
    }
}

# Full action substitutes for Copy-CardAndClose. They update an in-memory state
# and never call original wrappers, native methods, windows, or the clipboard.
function Get-HomeContext {
    $script:Flow.Events.Add('home')
    return [pscustomobject]@{ TestHome = $true }
}

function Get-TabSnapshot {
    $script:Flow.Events.Add('snapshot')
    return $script:Flow.Tabs
}

function Click-Element($Element) {
    $script:Flow.Events.Add('click')
    if ($script:Flow.ClickError) { Fail $script:Flow.ClickError }
    $script:Flow.Tabs = $script:Flow.AfterTabs
}

function Wait-OwnedTab($Before) {
    $script:Flow.Events.Add('wait-owned')
    if ($script:Flow.OwnershipError) { Fail $script:Flow.OwnershipError }
    return Get-OwnedTabId $Before $script:Flow.Tabs
}

function Wait-Article([string]$Title) {
    $script:Flow.Events.Add('validate-article')
    if ($script:Flow.WaitError -ceq 'USER_CANCELLED') { $script:Flow.Cancelled = $true }
    if ($script:Flow.WaitError -ceq 'FOREGROUND_IS_NOT_WECHAT') { $script:Flow.FocusLost = $true }
    if ($script:Flow.FocusRecoversBeforeCleanup) { $script:Flow.FocusLost = $false }
    if ($script:Flow.WaitError) { Fail $script:Flow.WaitError }
    if ($script:Flow.SwitchBeforeCopy) {
        $script:Flow.Tabs = @((New-Tab 'user-existing' $true), (New-Tab 'home' $false), (New-Tab 'owned-new' $false))
    }
    return [pscustomobject]@{ TestTitle = $Title }
}

function Copy-OfficialShortUrl($Article, $Before, [string]$OwnedId) {
    $script:Flow.Events.Add('copy')
    Assert-SameTabs $script:RunTabs $Before
    Assert-Equal 'owned-new' $OwnedId 'Copy wrapper did not receive the proven tab identity'
    $script:Diagnostic = @{} + $script:Flow.CopyDiagnostic
    if ($script:Flow.CopyError) { Fail $script:Flow.CopyError }
    return $script:Flow.Url
}

function Close-OwnedTab($Before, [string]$OwnedId) {
    Set-Stage 'CLOSE_ARTICLE'
    $script:Diagnostic = @{} + $script:Flow.CloseDiagnostic
    $script:Flow.CloseAttempts++
    if ($script:Flow.Cancelled) { Fail 'USER_CANCELLED' }
    if ($script:Flow.FocusLost) { Fail 'FOREGROUND_IS_NOT_WECHAT' }
    if ($script:Flow.CloseError) { Fail $script:Flow.CloseError }
    if ((Get-OwnedTabId $Before $script:Flow.Tabs) -cne $OwnedId) { Fail 'TAB_OWNERSHIP_UNVERIFIED' }
    $script:Flow.Events.Add('close:' + $OwnedId)
    $script:Flow.Tabs = @($Before)
    Assert-SameTabs $Before $script:Flow.Tabs
}

function Note([string]$Message) { $script:Flow.Notes.Add($Message) }

Test-Case 'card: offscreen pinned title remains structurally verifiable' {
    $f = New-CardFixture -Visible $false
    Assert-True ([object]::ReferenceEquals($f.Group, (Get-CardGroup $f.Title $f.App $true))) 'Offscreen pinned card was rejected'
}

Test-Case 'card: hidden second title prevents a broad ancestor being accepted' {
    $f = New-CardFixture
    $hidden = New-FakeElement 'second-title' '第二篇隐藏标题' -Visible $false
    $hidden.TestParent = $f.Group
    $f.Group.TestTextChildren += $hidden
    Assert-True ($null -eq (Get-CardGroup $f.Title $f.App $true)) 'Multiple structural titles must be ambiguous'
}

Test-Case 'card: pinned title does not require a reading metric' {
    $f = New-CardFixture -WithMetric $false
    Assert-True ([object]::ReferenceEquals($f.Group, (Get-CardGroup $f.Title $f.App $true))) 'Pinned card without metrics was rejected'
}

Test-Case 'card: ordinary title still requires the observed metric structure' {
    $f = New-CardFixture -WithMetric $false
    Assert-True ($null -eq (Get-CardGroup $f.Title $f.App)) 'Ordinary card without metrics was accepted'
}

Test-Case 'card: ordinary title and metric are accepted' {
    $f = New-CardFixture
    Assert-True ([object]::ReferenceEquals($f.Group, (Get-CardGroup $f.Title $f.App))) 'Valid ordinary card was rejected'
}

Test-Case 'card: identical title text cannot substitute another runtime ID' {
    $f = New-CardFixture
    $other = New-FakeElement 'different-id' $f.Title.Current.Name
    $f.Group.TestTextChildren = @($other, (New-FakeElement 'metric' '阅读 123'))
    Assert-True ($null -eq (Get-CardGroup $f.Title $f.App $true)) 'Matching text incorrectly proved element identity'
}

Test-Case 'card: app root cannot be accepted as the card' {
    $f = New-CardFixture
    $f.Title.TestParent = $f.App
    $f.App.TestTextChildren = $f.Group.TestTextChildren
    Assert-True ($null -eq (Get-CardGroup $f.Title $f.App $true)) 'App root was accepted as a card'
}

Test-Case 'card: detached title is rejected' {
    $f = New-CardFixture
    $f.Title.TestParent = $null
    Assert-True ($null -eq (Get-CardGroup $f.Title $f.App $true)) 'Detached title was accepted'
}

Test-Case 'viewport: historical partial bottom title is not clickable despite IsOffscreen=false' {
    $f = New-CardFixture
    $f.Title.Current.BoundingRectangle = New-FakeRect 3349 1127 301 23
    $f.App.TestTextChildren = @((New-FakeElement 'date' '昨天'), $f.Title, (New-FakeElement 'metric' '阅读 123'))
    $profile = [pscustomobject]@{
        App = $f.App
        ArticleLink = New-FakeElement 'article-tab' '文章' -Rect (New-FakeRect 3349 100 60 20)
        Window = New-FakeElement 'window' '' -Rect (New-FakeRect 3000 0 1000 1140)
    }
    Assert-Equal 0 @(Get-VisibleCards $profile).Count 'Partially clipped historical card was returned'
}

Test-Case 'viewport: fully visible ordinary card remains collectable' {
    $f = New-CardFixture
    $f.Title.Current.BoundingRectangle = New-FakeRect 3349 1027 301 23
    $f.App.TestTextChildren = @((New-FakeElement 'date' '昨天'), $f.Title, (New-FakeElement 'metric' '阅读 123'))
    $profile = [pscustomobject]@{
        App = $f.App
        ArticleLink = New-FakeElement 'article-tab' '文章' -Rect (New-FakeRect 3349 100 60 20)
        Window = New-FakeElement 'window' '' -Rect (New-FakeRect 3000 0 1000 1140)
    }
    $cards = @(Get-VisibleCards $profile)
    Assert-Equal 1 $cards.Count 'Fully visible card was not returned'
    Assert-Equal 'title' $cards[0].RuntimeId 'Wrong card was returned'
}

Test-Case 'tabs: unchanged tabs may appear in a different enumeration order' {
    $before = @(New-BeforeTabs)
    Assert-SameTabs $before @($before[1], $before[0])
}

Test-Case 'tabs: changed selected user tab is rejected' {
    Assert-Throws 'TAB_SET_CHANGED' {
        Assert-SameTabs @(New-BeforeTabs) @((New-Tab 'user-existing' $true), (New-Tab 'home' $false))
    }
}

Test-Case 'tabs: missing old tab is rejected' {
    Assert-Throws 'TAB_SET_CHANGED' { Assert-SameTabs @(New-BeforeTabs) @((New-Tab 'home' $true)) }
}

Test-Case 'tabs: same count with a replaced old tab is rejected' {
    Assert-Throws 'TAB_SET_CHANGED' {
        Assert-SameTabs @(New-BeforeTabs) @((New-Tab 'unknown' $false), (New-Tab 'home' $true))
    }
}

Test-Case 'ownership: one selected new tab with all old tabs retained is accepted' {
    Assert-Equal 'owned-new' (Get-OwnedTabId @(New-BeforeTabs) @(New-AfterTabs)) 'Wrong new tab owner'
}

Test-Case 'ownership: same-tab navigation cannot establish a new owned tab' {
    Assert-Throws 'TAB_OWNERSHIP_UNVERIFIED' { Get-OwnedTabId @(New-BeforeTabs) @(New-BeforeTabs) }
}

Test-Case 'ownership: multiple new tabs are rejected' {
    $after = @(New-AfterTabs) + @((New-Tab 'unexpected-new' $false))
    Assert-Throws 'TAB_OWNERSHIP_UNVERIFIED' { Get-OwnedTabId @(New-BeforeTabs) $after }
}

Test-Case 'ownership: lost old tab is rejected even when total count grew by one' {
    $after = @((New-Tab 'impostor' $false), (New-Tab 'home' $false), (New-Tab 'owned-new' $true))
    Assert-Throws 'TAB_SET_CHANGED' { Get-OwnedTabId @(New-BeforeTabs) $after }
}

Test-Case 'ownership: background new tab is rejected' {
    $after = @((New-Tab 'user-existing' $false), (New-Tab 'home' $true), (New-Tab 'owned-new' $false))
    Assert-Throws 'TAB_OWNERSHIP_UNVERIFIED' { Get-OwnedTabId @(New-BeforeTabs) $after }
}

Test-Case 'ownership: multiple selected tabs are rejected' {
    $after = @((New-Tab 'user-existing' $false), (New-Tab 'home' $true), (New-Tab 'owned-new' $true))
    Assert-Throws 'TAB_OWNERSHIP_UNVERIFIED' { Get-OwnedTabId @(New-BeforeTabs) $after }
}

Test-Case 'ownership: duplicate original tab ID is rejected' {
    $after = @((New-Tab 'home' $false), (New-Tab 'home' $false), (New-Tab 'owned-new' $true))
    Assert-Throws 'TAB_SET_CHANGED' { Get-OwnedTabId @(New-BeforeTabs) $after }
}

Test-Case 'observation: an unchanged runtime ID is visited only once' {
    $seen = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $card = [pscustomobject]@{ RuntimeId = 'one'; Date = '昨天'; Title = '测试标题' }
    Assert-True (Register-CardObservation $seen $card) 'First observation was ignored'
    Assert-True (-not (Register-CardObservation $seen $card)) 'Unchanged card was revisited'
}

Test-Case 'observation: whitespace-normalized title is the same card' {
    $seen = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $null = Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'one'; Date = '昨天'; Title = '第 40届' })
    Assert-True (-not (Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'one'; Date = '昨天'; Title = "第$([char]0xA0)40届" }))) 'Whitespace variant was revisited'
}

Test-Case 'observation: reused runtime ID with another title fails' {
    $seen = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $null = Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'one'; Date = '昨天'; Title = '标题一' })
    Assert-Throws 'CARD_ID_REUSED' {
        Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'one'; Date = '昨天'; Title = '标题二' })
    }
}

Test-Case 'observation: reused runtime ID with another date fails' {
    $seen = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $null = Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'one'; Date = '昨天'; Title = '标题' })
    Assert-Throws 'CARD_ID_REUSED' {
        Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'one'; Date = '今天'; Title = '标题' })
    }
}

Test-Case 'observation: equal titles on distinct runtime IDs are not prematurely merged' {
    $seen = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $null = Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'one'; Date = '昨天'; Title = '同名文章' })
    Assert-True (Register-CardObservation $seen ([pscustomobject]@{ RuntimeId = 'two'; Date = '昨天'; Title = '同名文章' })) 'Distinct cards were incorrectly merged by title'
}

Test-Case 'flow: successful copy closes only the owned tab and restores old tabs' {
    Reset-Flow
    Assert-Equal $script:Flow.Url (Copy-CardAndClose ([pscustomobject]@{}) '文章标题') 'Copy result changed'
    Assert-Equal 1 @($script:Flow.Events | Where-Object { $_ -ceq 'close:owned-new' }).Count 'New tab was not closed exactly once'
    Assert-SameTabs $script:RunTabs $script:Flow.Tabs
}

Test-Case 'flow: article validation failure closes the proven new tab and preserves the first error' {
    Reset-Flow
    $script:Flow.WaitError = 'ARTICLE_TITLE_MISMATCH'
    Assert-Throws 'ARTICLE_TITLE_MISMATCH' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 1 @($script:Flow.Events | Where-Object { $_ -ceq 'close:owned-new' }).Count 'Failed article left an owned tab open'
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -ceq 'copy' }).Count 'Invalid article reached copy'
    Assert-Equal 'OPEN_ARTICLE' $script:Stage 'Cleanup replaced original failed stage'
    Assert-SameTabs $script:RunTabs $script:Flow.Tabs
}

Test-Case 'flow: copy failure remains primary when cleanup also fails' {
    Reset-Flow
    $script:Flow.CopyError = 'COPY_DID_NOT_CHANGE_CLIPBOARD'
    $script:Flow.CloseError = 'TAB_SET_CHANGED'
    Assert-Throws 'COPY_DID_NOT_CHANGE_CLIPBOARD' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 'COPY_LINK' $script:Stage 'Original copy stage was lost'
    Assert-True ($script:Flow.Notes.Contains('COLLECT_CLEANUP: TAB_SET_CHANGED')) 'Secondary cleanup error was not reported'
}

Test-Case 'flow: first diagnostic survives a different cleanup diagnostic and failure' {
    Reset-Flow
    $script:Flow.CopyError = 'COPY_DID_NOT_CHANGE_CLIPBOARD'
    $script:Flow.CloseError = 'TAB_SET_CHANGED'
    $script:Flow.CopyDiagnostic = @{ copyPhase = 'await-sequence'; sequenceChanged = $false }
    $script:Flow.CloseDiagnostic = @{ cleanupPhase = 'check-tabs'; tabItems = 4 }
    Assert-Throws 'COPY_DID_NOT_CHANGE_CLIPBOARD' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 1 $script:Flow.CloseAttempts 'Fixture did not exercise cleanup failure'
    Assert-Equal 'COPY_LINK' $script:Stage 'Cleanup replaced the original stage'
    Assert-Equal 2 $script:Diagnostic.Count 'Cleanup added or removed original diagnostic fields'
    Assert-Equal 'await-sequence' $script:Diagnostic.copyPhase 'Original copy diagnostic was overwritten'
    Assert-Equal $false $script:Diagnostic.sequenceChanged 'Original diagnostic value was overwritten'
    Assert-True (-not $script:Diagnostic.ContainsKey('cleanupPhase')) 'Cleanup diagnostic leaked into the primary failure'
}

Test-Case 'flow: cleanup failure is reported after an otherwise successful copy' {
    Reset-Flow
    $script:Flow.CloseError = 'TAB_SET_CHANGED'
    Assert-Throws 'TAB_SET_CHANGED' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 'CLOSE_ARTICLE' $script:Stage 'Cleanup failure stage was lost'
}

Test-Case 'flow: unproven ownership never triggers close' {
    Reset-Flow
    $script:Flow.OwnershipError = 'TAB_OWNERSHIP_UNVERIFIED'
    Assert-Throws 'TAB_OWNERSHIP_UNVERIFIED' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 0 $script:Flow.CloseAttempts 'Close wrapper was called without ownership proof'
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -ceq 'copy' }).Count 'Unowned article reached copy'
}

Test-Case 'flow: Esc after ownership proof prevents all close mutations' {
    Reset-Flow
    $script:Flow.WaitError = 'USER_CANCELLED'
    Assert-Throws 'USER_CANCELLED' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 0 $script:Flow.CloseAttempts 'Esc must skip the close wrapper entirely'
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -like 'close:*' }).Count 'Esc was followed by a close mutation'
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -ceq 'copy' }).Count 'Esc was followed by a copy'
}

Test-Case 'flow: foreground loss skips cleanup even if focus immediately recovers' {
    Reset-Flow
    $script:Flow.WaitError = 'FOREGROUND_IS_NOT_WECHAT'
    $script:Flow.FocusRecoversBeforeCleanup = $true
    Assert-Throws 'FOREGROUND_IS_NOT_WECHAT' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal $false $script:Flow.FocusLost 'Fixture must restore focus before the cleanup decision'
    Assert-Equal 0 $script:Flow.CloseAttempts 'Foreground loss must skip close even after focus recovers'
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -like 'close:*' }).Count 'Focus loss was followed by a close mutation'
}

foreach ($stopCode in @('USER_CANCELLED', 'FOREGROUND_IS_NOT_WECHAT')) {
    Test-Case ('flow: ' + $stopCode + ' during copy skips cleanup without relying on persistent mock flags') {
        Reset-Flow
        $script:Flow.CopyError = $stopCode
        Assert-Throws $stopCode { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
        Assert-Equal $false $script:Flow.Cancelled 'Fixture must not rely on the cancel flag'
        Assert-Equal $false $script:Flow.FocusLost 'Fixture must not rely on continued foreground loss'
        Assert-Equal 0 $script:Flow.CloseAttempts 'Interruption during copy called the close wrapper'
        Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -like 'close:*' }).Count 'Interruption during copy closed a tab'
    }
}

Test-Case 'flow: user selection change before copy prevents both copy and close' {
    Reset-Flow
    $script:Flow.SwitchBeforeCopy = $true
    Assert-Throws 'TAB_OWNERSHIP_UNVERIFIED' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -ceq 'copy' }).Count 'User tab was copied'
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -like 'close:*' }).Count 'User tab was closed'
}

Test-Case 'flow: preexisting tab change aborts before clicking any card' {
    Reset-Flow
    $script:Flow.Tabs = @((New-Tab 'different-user-page' $false), (New-Tab 'home' $true))
    Assert-Throws 'TAB_SET_CHANGED' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 0 @($script:Flow.Events | Where-Object { $_ -ceq 'click' }).Count 'Card was clicked after baseline tabs changed'
    Assert-Equal 0 $script:Flow.CloseAttempts 'Unexpected cleanup was attempted'
}

Test-Case 'flow: click failure never claims or closes a tab' {
    Reset-Flow
    $script:Flow.ClickError = 'CLICK_POINT_NOT_OWNED_BY_WECHAT'
    Assert-Throws 'CLICK_POINT_NOT_OWNED_BY_WECHAT' { Copy-CardAndClose ([pscustomobject]@{}) '文章标题' }
    Assert-Equal 0 $script:Flow.CloseAttempts 'Failed click led to closing a user tab'
}

Test-Case 'isolation: collector native class was never compiled or loaded' {
    Assert-True ($null -eq ('WeChatCollectorWin32' -as [type])) 'Native helper appeared during offline tests'
}

$failed = @($script:results | Where-Object { -not $_.passed })
[pscustomobject]@{
    suite = 'wechat-desktop-offline'
    sourceContentSha256 = $sourceHash
    importedFunctions = $functionNames
    total = $script:results.Count
    passed = $script:results.Count - $failed.Count
    failed = $failed.Count
    nativeHelperLoaded = $null -ne ('WeChatCollectorWin32' -as [type])
    tests = $script:results.ToArray()
} | ConvertTo-Json -Depth 5
if ($failed.Count -gt 0) { exit 1 }
exit 0
