# Contributing

Bug reports and pull requests are welcome. For anything larger than a small fix, please open an issue first so the approach can be agreed on.

## Setup

The project requires Node.js 24.9 or newer, pnpm, and DeepSeek Harness 0.2.2-rc.3:

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.3
pnpm install
pnpm build
```

Linux integration tests also use bubblewrap.

## Tests

```sh
pnpm typecheck
pnpm build
pnpm test          # complete suite
pnpm test:unit     # root unit tests
pnpm test:proofs   # integration and runtime proofs
pnpm test:pack     # packed-install checks
```

The tests locate DSH through the `dsh` command. Set `DSH_NATIVE_ANCHOR` to the path of DSH's `package.json` to use another installation. Tests start real processes in temporary directories and never call a model.

## Trying a local build

Use a separate DSH home so local settings, sessions and instruction files do not affect the result:

```sh
export DSH_HOME=~/.dsh-zcode-dev DSH_AGENTS_HOME=~/.dsh-zcode-dev/agents
dsh --profile zcode-dev --from-default-profile web --dump-config > /dev/null
dsh plugin --profile zcode-dev add link:$PWD
dsh --profile zcode-dev --port 13181
```

Sign in to a model provider in the web UI, then run `pnpm build` and restart DSH after each change.

## Evaluation

[eval/round-1/README.md](eval/round-1/README.md) describes the smoke benchmark procedure. Changes that affect agent behavior should be evaluated on the presets they touch and against the documented control.

## Style

Write TypeScript that Node can run with type stripping, so avoid enums and namespaces. Add a short comment wherever the reason for the code is not obvious. Keep commits focused, and write the subject line in the imperative, such as “Add …” or “Fix …”.

## Releases

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `package.json`.
3. Commit, then tag `vX.Y.Z` and push the tag.

The release workflow tests the tag, packages the tarball with a build-provenance attestation, stages it on npm with provenance, and creates the GitHub release with the tarball and generated notes. Tags with a hyphen, such as `v0.2.0-rc.1`, are marked as prereleases. npm packages are staged rather than published immediately; promote the staged version on npmjs.com or with `npm stage approve`.
