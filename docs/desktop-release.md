# Full Desktop release procedure

## Supported release target

The initial public channel targets Windows 10/11 x64 and produces two artifacts:

- `Time Series Explorer-<version>-setup-x64.exe`
- `Time Series Explorer-<version>-portable-x64.exe`

GitHub Releases is the distribution source. Generated binaries are never committed to Git.

## Release checklist

1. Freeze feature work and update `package.json`, `package-lock.json`, `APP_VERSION`, the Desktop manifest and release notes to the same semantic version.
2. Run `npm ci`, `npm run test:release`, `npm audit --omit=dev --audit-level=critical`, and `npm run build:web` from a clean checkout.
3. Build locally with `npm run desktop:dist:x64` and generate hashes with `npm run desktop:checksums`.
4. Smoke-test setup and portable artifacts on a clean Windows x64 installation, including offline startup, local files, save/restore, Live Update and uninstall.
5. Commit and push the release source to `main`.
6. Create and push the matching `v<package-version>` annotated tag.
7. The `Release Full Desktop` workflow repeats all tests, builds both artifacts, calculates SHA-256 hashes and creates the GitHub Release.
8. Verify the release downloads, GitHub Pages Desktop link and release notes.

## Signing policy

Beta builds may be published unsigned when the release notes clearly disclose the Windows SmartScreen warning and checksums are provided. A broadly promoted stable release should be Authenticode-signed. Signing credentials belong only in encrypted GitHub Actions secrets and must never be committed.

The runtime isolation and current dependency-audit exception are documented in [desktop-security.md](desktop-security.md).

## Updates

The beta channel uses manual updates. Every release is immutable and tied to an annotated Git tag. Users obtain newer versions from GitHub Releases; the web manifest points to the recommended installer.

## Rollback

If a release is defective, mark it as a prerelease or remove it from the recommended web manifest, restore the manifest to the previous known-good version, and redeploy Pages. Do not reuse or move an existing release tag; prepare a new patch version after fixing the problem.
