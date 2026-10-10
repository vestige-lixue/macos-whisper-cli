# macOS Whisper CLI

Prebuilt [whisper.cpp](https://github.com/ggml-org/whisper.cpp) CLI packages for macOS, used by [Vestige](https://github.com/vestige-lixue/vestige).

Download an archive from [Releases](https://github.com/vestige-lixue/macos-whisper-cli/releases/latest) and verify it against `SHA256SUMS`.

| Architecture | Backends | Deployment target |
| --- | --- | --- |
| arm64 | CPU, Metal | macOS 13.3 |
| x64 | CPU | macOS 13.3 |

Archives include `whisper-cli`, runtime libraries and the upstream MIT license. Models are separate. Developer ID signing and notarization are left to the consuming application.

## Automation

The [workflow](.github/workflows/build.yml) checks stable upstream releases daily at **03:23 UTC**. It builds only when the source commit or build configuration changes, using the same pinned commit for both architectures.

Both builds must pass architecture verification and an extracted-archive JSON smoke test before publication. Releases include both archives, `SHA256SUMS` and `build.json` with source and build details. Failed builds and incomplete drafts retry on later checks; published assets are never overwritten. Older versions do not replace Latest.

To start, push these files to the default branch and run **Actions → Build macOS Whisper CLI → Run workflow**, or wait for the schedule. Leave `whisper_tag` empty for the latest stable version, or specify a stable tag. The built-in `GITHUB_TOKEN` is sufficient; no additional secrets are needed.

## Scripts

- `scripts/build.sh`: compile, test and package the CLI.
- `scripts/release.mjs`: select releases, decide whether to build, verify and publish assets, and maintain repository activity.