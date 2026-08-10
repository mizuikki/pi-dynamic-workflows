# Contributing

Thanks for contributing to Pi Workflow Orchestrator. This project values small,
well-tested changes that keep the workflow runtime predictable. A few conventions
keep review fast.

## Before you open a PR

```bash
npm install
npm test     # biome check + tsc build + unit tests; must pass
```

`npm test` runs exactly what CI runs. If it's green locally it should be green in CI. CI runs on every PR to `main`; for fork PRs a maintainer approves the first run.

## What a good PR looks like

- **One concern per PR.** Keep a bug fix, a feature, and a refactor in separate PRs. A mixed PR (e.g. a test-infra fix *and* a new runtime feature) is harder to review and to revert; split it if you can.
- **Conventional Commits.** Use `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, etc. The type drives versioning, so it matters: anything that adds or changes public API (new tool params, new settings, new exported options) is a `feat:`, not a `fix:`, even if it's small. Maintainers squash-merge, so the PR title becomes the commit — make it accurate.
- **Backward compatible by default.** New options should be optional with conservative defaults (off unless configured).

## When you add user-facing config

If you add a `workflow` tool parameter or a
`~/.pi/workflow-orchestrator/settings.json` setting, document it in `README.md`
in the same place the existing ones live. Undocumented config is treated as
incomplete.

## When you change runtime behavior

Fake-agent unit tests are necessary but not sufficient. Any change to how agents actually run — retries, timeouts, model routing, token accounting, concurrency, resume — must also be verified **end-to-end against a real Pi subagent session** (real `createAgentSession` → real model), because the real SDK path behaves differently than a mock. If you don't have a real-provider environment, say so in the PR and a maintainer will run it before merge.

Use the checked-in pinned fork and package smoke harnesses for this verification.
Do not commit one-off harnesses or replace the archived SDK fixture with a
mutable branch checkout.

## Local installation

This package is private and is supported only as a local Pi extension. From a
checkout, use:

```bash
pi install -l <absolute-source-path>
pi remove <absolute-source-path> -l
```

Do not add registry publication, registry-install instructions, or Pi product
version ranges as extension compatibility claims. Compatibility is established
by the three extension API versions and the pinned fork fixture.

## Style

Formatting and linting are handled by Biome (`npm run format`, `npm run lint`). Match the existing code; don't reformat files you aren't otherwise changing.
