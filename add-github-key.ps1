# Get GitHub's host key and add to known_hosts
$knownHostsPath = "$env:USERPROFILE\.ssh\known_hosts"
$githubHostKey = & "C:\Program Files\Git\usr\bin\ssh-keyscan.exe" -t rsa github.com 2>$null

if ($githubHostKey) {
    Add-Content -Path $knownHostsPath -Value $githubHostKey -Encoding ascii
    Write-Host "GitHub host key added to known_hosts" -ForegroundColor Green
} else {
    Write-Host "Failed to get GitHub host key" -ForegroundColor Red
}
