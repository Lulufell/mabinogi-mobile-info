param([ValidateSet('install','login','deploy','dev')][string]$Action='install')
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
$npmTool=Get-Command npm.cmd -ErrorAction SilentlyContinue
$pnpmTool=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$nodeTool=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if($Action -eq 'install'){
    if($npmTool){ & $npmTool.Source install }
    elseif(Test-Path -LiteralPath $pnpmTool){ & $pnpmTool install }
    else{ throw 'Install Node.js LTS and reopen PowerShell.' }
} else {
    $wranglerTool=Join-Path $PSScriptRoot 'node_modules\wrangler\bin\wrangler.js'
    if(-not(Test-Path -LiteralPath $wranglerTool)){throw 'Run install first.'}
    if(Test-Path -LiteralPath $nodeTool){ & $nodeTool $wranglerTool $Action }
    else{ & node $wranglerTool $Action }
}
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
