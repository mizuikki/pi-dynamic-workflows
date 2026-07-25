# Local Pi Fork Rules

- This private extension targets the sibling `../pi` fork. Direct Pi SDK imports
  are exact `0.81.1-local.1` peers and `file:../pi/packages/...` development
  dependencies only. Do not add Pi SDK packages to `dependencies` or import Pi
  source paths.
- The extension factory must preflight `ExtensionAPI.modelRuntimeApiVersion`
  before registering tools or commands. Do not silently fall back to upstream Pi.
- Local extension installation uses `pi install -l <absolute-source-path>` and
  `pi remove <absolute-source-path> -l`. Do not document registry installation
  or add publishing automation.
- Fork fixtures are made with `mkdtemp`: `<temp>/pi` contains the archived host
  and `<temp>/project` the extension copy. Read the Pi SDK manifest, verify its
  SHA-256 digests, and add all four SDK tarballs directly to positive consumers.
- Prove static import aliasing with the real Pi loader and poison packages, not
  with `import.meta.resolve()` or tarball filename inference.
