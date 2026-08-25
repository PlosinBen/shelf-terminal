param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Url
)

$ErrorActionPreference = 'Stop'
if ($Url.Length -eq 0 -or $Url.Length -gt 8192) { exit 65 }

$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Url))
$payload = $payload.TrimEnd('=').Replace('+', '-').Replace('/', '_')
if ($payload.Length -gt 10923) { exit 65 }

$frame = "$([char]27)]6973;external-url;1;$payload$([char]7)"
$bytes = [Text.Encoding]::ASCII.GetBytes($frame)
$stream = [IO.File]::Open('CONOUT$', [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
try {
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
} finally {
  $stream.Dispose()
}
