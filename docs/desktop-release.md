# Full Desktop release procedure

## Supported release targets

The tagged release workflow builds these Full Desktop artifacts:

- `Time Series Explorer-<version>-setup-x64.exe`
- `Time Series Explorer-<version>-portable-x64.exe`
- `Time Series Explorer-<version>-mac-x64.dmg`
- `Time Series Explorer-<version>-mac-x64.zip`
- `Time Series Explorer-<version>-mac-arm64.dmg`
- `Time Series Explorer-<version>-mac-arm64.zip`
- `Time Series Explorer-<version>-linux-amd64.deb`
- `Time Series Explorer-<version>-linux-x86_64.AppImage`

GitHub Releases is the distribution source. Generated binaries are never committed to Git.

## Release checklist

1. Freeze feature work and update `package.json`, `package-lock.json`, `APP_VERSION`, the Desktop manifest and release notes to the same semantic version.
2. Run `npm ci`, `npm run test:release`, `npm audit --omit=dev --audit-level=critical`, and `npm run build:web` from a clean checkout.
3. Build the local target with the matching command: `npm run desktop:dist:x64`, `npm run desktop:dist:macos:x64`, `npm run desktop:dist:macos:arm64`, or `npm run desktop:dist:linux:x64`. Generate hashes with `npm run desktop:checksums`.
4. The tagged `Release Full Desktop` workflow builds Windows, macOS Intel, macOS Apple silicon and Linux x86_64 on native runners, inspects each packaged runtime, generates per-target SHA-256 files and attaches all artifacts to one GitHub Release.
5. Smoke-test the setup/portable artifacts on their target platforms, including offline startup, local files, save/restore, Live Update and uninstall where applicable.
6. Commit and push the release source to `main`.
7. Create and push the matching `v<package-version>` annotated tag.
8. Verify the release downloads, GitHub Pages Desktop link and release notes.

## Signing policy

Beta builds may be published unsigned when the release notes clearly disclose the Windows SmartScreen and macOS Gatekeeper warnings and checksums are provided. A broadly promoted stable release should be Authenticode-signed, macOS-signed and notarized. Signing credentials belong only in encrypted GitHub Actions secrets and must never be committed.

The runtime isolation and current dependency-audit exception are documented in [desktop-security.md](desktop-security.md).

## Updates

The beta channel uses manual updates. Every release is immutable and tied to an annotated Git tag. Users obtain newer versions from GitHub Releases; the web manifest points to the recommended installer and exposes the platform assets once that release has been published.

## Rollback

If a release is defective, mark it as a prerelease or remove it from the recommended web manifest, restore the manifest to the previous known-good version, and redeploy Pages. Do not reuse or move an existing release tag; prepare a new patch version after fixing the problem.
