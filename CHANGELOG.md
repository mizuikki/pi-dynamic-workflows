# Changelog

## [Unreleased]

### Added

- Pi session-scope filtering for Workflow Model selection, agent model
  overrides, `/workflow model`, prompt guidance, and resume admission.

### Changed

- Empty Pi scopes remain unscoped; non-empty scopes are enforced as canonical
  allowlists. Scope-pinned reasoning effort is used only as a selection default.
- Resumes keep the persisted concrete model and effort across unrelated scope
  or default changes, and fail closed before replay when either is no longer
  permitted or supported.
