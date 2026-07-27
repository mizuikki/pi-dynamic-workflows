# Local Pi Fork Rules

- This private extension targets the sibling `../pi` fork. Direct Pi SDK imports
  are wildcard peers and `file:../pi/packages/...` development dependencies
  only. Pi product versions do not define extension compatibility. Do not add
  Pi SDK packages to `dependencies` or import Pi source paths.
- The extension factory must preflight `ExtensionAPI.extensionSdkApiVersion`
  and `ExtensionAPI.modelRuntimeApiVersion` before registering tools or
  commands. Do not silently fall back to upstream Pi.
- Local extension installation uses `pi install -l <absolute-source-path>` and
  `pi remove <absolute-source-path> -l`. Do not document registry installation
  or add publishing automation.
- Fork fixtures are made with `mkdtemp`: `<temp>/pi` contains the archived host
  and `<temp>/project` the extension copy. Read the Pi SDK manifest, verify its
  SHA-256 digests, and add all four SDK tarballs directly to positive consumers.
- Prove static import aliasing with the real Pi loader and poison packages, not
  with `import.meta.resolve()` or tarball filename inference.
- Blocking compatibility CI must use an immutable protected
  `pi-extension-sdk-v<major>.<minor>.<patch>` tag after the stacked migration;
  branch refs are only for the current coordination phase.
- Current blocking CI pin: `pi-extension-sdk-v1.1.0` (private fork product
  `0.82.1-local.1`; ABI remains `extensionSdkApiVersion` 1). Stock/public
  fail-closed package-smoke uses npm `0.82.1`.
