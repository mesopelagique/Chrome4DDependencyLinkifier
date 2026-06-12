# 4D Dependency Linkifier

Chrome extension that turns GitHub references inside 4D `Project/Sources/dependencies.json` files into clickable links.

## Behavior

On GitHub blob pages matching:

`https://github.com/<owner>/<repo>/blob/<ref>/Project/Sources/dependencies.json`

the extension:

- turns each dependency `github` value into a link to that repository
- turns each dependency `tag` value into a link to the matching GitHub release page

Example:

```json
{
  "dependencies": {
    "JSONRPC": {
      "github": "mesopelagique/JSONRPC",
      "tag": "1.0.0"
    }
  }
}
```

becomes clickable as:

- `mesopelagique/JSONRPC` -> `https://github.com/mesopelagique/JSONRPC`
- `1.0.0` -> `https://github.com/mesopelagique/JSONRPC/releases/tag/1.0.0`

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder.

## Files

- `manifest.json`: MV3 extension manifest
- `content.js`: GitHub page matcher and in-place linkifier

## Release Packaging

When a GitHub Release is published, the workflow in `.github/workflows/release-extension.yml` builds a zip archive containing the extension files and uploads that archive to the release assets.

The archive name follows this pattern:

- `<repository-name>-<tag>.zip`

If you rename the repository to `Chrome4DDependencyLinkifier`, future release assets will automatically use that repository name.