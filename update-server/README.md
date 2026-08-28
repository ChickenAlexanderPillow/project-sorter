# Internal update server

This is a small, reusable Nginx container. Each application gets its own folder under `data`, for example:

```text
data/
  pepper/
    latest.json
    Pepper-0.2.0.msi.zip
  another-app/
    latest.json
```

Start it from the repository root:

```powershell
docker compose up -d
Invoke-WebRequest http://localhost:8088/health
```

The service listens on port `8088` on the host computer. Allow inbound TCP 8088 through Windows Firewall and give the computer a reserved DHCP address or internal DNS name. The app currently points at `DESKTOP-CALLUM:8088`.

## Publishing Pepper

Build signed updater artifacts with the private key stored outside the repository:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\Coding\project-sorter-secrets\pepper.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<the password used when generating the key>"
pnpm tauri build
```

Then publish the generated signed zip. The exact artifact path depends on the selected Windows bundle; it is normally under `src-tauri/target/release/bundle/`:

```powershell
.\scripts\publish-update.ps1 `
  -Version 0.2.0 `
  -InstallerArtifact .\src-tauri\target\release\bundle\msi\Pepper_0.2.0_x64_en-US.msi `
  -Signature .\src-tauri\target\release\bundle\msi\Pepper_0.2.0_x64_en-US.msi.sig
```

Update `src-tauri/tauri.conf.json` to the same version before building. The app checks for updates at startup; installation is user-confirmed and the updater is signed.

The current endpoint uses HTTP because this is intended for a trusted LAN. For untrusted networks, put HTTPS in front of the service and remove `dangerousInsecureTransportProtocol` from the Tauri configuration.
