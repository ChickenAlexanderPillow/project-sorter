param([string]$Output = "$env:USERPROFILE\Videos\Pepper Overlap Demo 2026-11-10",[string]$FFmpeg = 'ffmpeg')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$clips = @(
 @{Name='A_Camera_01.mp4'; Start='2026-11-09T12:00:00Z'; Duration=30; Color='0x4b6575'},
 @{Name='A_Microphone.m4a'; Start='2026-11-09T12:00:20Z'; Duration=160},
 @{Name='A_Camera_02.mp4'; Start='2026-11-09T12:02:30Z'; Duration=45; Color='0x596c57'},
 @{Name='B_Long_Microphone.m4a'; Start='2026-11-09T13:00:00Z'; Duration=3600},
 @{Name='B_Short_Camera.mp4'; Start='2026-11-09T13:00:01Z'; Duration=1; Color='0x776448'},
 @{Name='B_Late_Camera.mp4'; Start='2026-11-09T13:59:45Z'; Duration=5; Color='0x685a74'},
 @{Name='No_Overlap.mp4'; Start='2026-11-09T12:04:00Z'; Duration=10; Color='0x565656'},
 @{Name='Touching_01.mp4'; Start='2026-11-09T14:30:00Z'; Duration=10; Color='0x565656'},
 @{Name='Touching_02.mp4'; Start='2026-11-09T14:30:10Z'; Duration=10; Color='0x565656'}
)
foreach ($clip in $clips) {
 $dest = Join-Path $Output $clip.Name
 if (Test-Path -LiteralPath $dest) { throw "Refusing to overwrite $dest" }
 if ($clip.Color) {
   & $FFmpeg -v error -f lavfi -i "color=c=$($clip.Color):s=320x180:r=10" -t $clip.Duration -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -metadata "creation_time=$($clip.Start)" -movflags +faststart -n $dest
 } else {
   & $FFmpeg -v error -f lavfi -i 'sine=frequency=220:sample_rate=8000' -t $clip.Duration -af volume=0.05 -c:a aac -b:a 16k -metadata "creation_time=$($clip.Start)" -n $dest
 }
 if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed: $($clip.Name)" }
}
$clips | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Output 'expected.json')
Write-Output "Generated originals: $Output"
