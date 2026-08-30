# Fork desktop releases

Taylor's fork uses the upstream T3 Connect service and ships the same desktop code to two roles:

- A macOS Apple Silicon control center.
- Windows ARM64 workstations that run project-specific agents and Computer Use.

The fork's `main` branch remains an upstream mirror. Desktop releases are built only from
`dev/next-release` by the **Fork Desktop Release** workflow. That workflow never publishes the CLI,
deploys a relay or web app, or writes a release commit back to a branch.

## Release contents

Each release has two user-facing installers:

- `T3-Code-<version>-arm64.dmg` for macOS.
- `T3-Code-<version>-arm64.exe` for Windows.

Electron's updater also requires a macOS ZIP, blockmaps, and YAML manifests. Those are machine-read
release assets rather than additional products. Removing them makes in-app updates fail.

Both builds set the update repository to `T-Py-T/t3code`. The app keeps the upstream bundle and app
identity so it behaves like the normal T3 desktop app, while update checks stay within the fork.
Fork releases use `fork-v<version>` tags so they cannot collide with tags mirrored from upstream.

## T3 Connect configuration

T3 Connect is compiled into the web client bundled by both installers. Configure these public GitHub
repository variables before running a release:

- `T3CODE_CLERK_PUBLISHABLE_KEY`
- `T3CODE_CLERK_JWT_TEMPLATE`
- `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`
- `T3CODE_RELAY_URL`
- `T3CODE_CLERK_PASSKEY_RP_DOMAINS` (optional when derivable from the publishable key)

The workflow fails before building when the four required values are absent. It does not deploy or
replace the default T3 Connect backend.

## Signing

Set **Sign and notarize both installers** for any build intended to replace an installed app. Signed
releases require the following repository configuration.

macOS variables and secrets:

- Variable: `APPLE_TEAM_ID`
- Secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, and `MACOS_PROVISIONING_PROFILE`

The provisioning profile must cover `com.t3tools.t3code` and the Clerk passkey associated domain.

Windows secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Windows Computer Use validates that the desktop executable and native helper have the same trusted
publisher. An unsigned Windows build is useful for packaging tests but is not a complete Computer Use
release.

## Build and publish

1. Merge tested provider and Computer Use branches into the fork's `dev/next-release` branch.
2. Run **Fork Desktop Release** from `dev/next-release` with a stable numeric version greater than the
   last fork release.
3. Keep **Publish a GitHub Release** off for a packaging-only run. The DMG, EXE, and updater files are
   retained as workflow artifacts for inspection.
4. Run again with signing and publishing enabled after the packaging run passes.
5. On macOS, verify launch, T3 Connect sign-in, provider selection, and Computer Use permission state.
6. On the Windows UTM host, verify installation, T3 Connect device registration, provider turns,
   native Computer Use actions, and an update check against the fork release.

The workflow accepts only stable numeric versions because the desktop's stable updater ignores
GitHub prereleases. The small updater assets must remain attached to the release even though users
normally download only the DMG or EXE. The workflow rejects publishing when signing is disabled;
unsigned artifacts can be downloaded only from a packaging-only workflow run.
