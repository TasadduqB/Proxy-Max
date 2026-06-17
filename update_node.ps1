$url = "https://nodejs.org/dist/v24.16.0/node-v24.16.0-x64.msi"
$output = "$env:TEMP\node-v24.16.0-x64.msi"
Write-Host "Downloading $url to $output..."
Invoke-WebRequest -Uri $url -OutFile $output
Write-Host "Download complete. Installing..."
$process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$output`" /qn /norestart" -Wait -PassThru
if ($process.ExitCode -eq 0) {
    Write-Host "Installation successful."
} else {
    Write-Host "Installation failed with exit code $($process.ExitCode)."
}
