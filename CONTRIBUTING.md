# Contributing to CLPRouter

Thank you for helping. This project is MIT-licensed and follows the CLPR project's (LFDT-CLPR) contribution practices:
Developer Certificate of Origin sign-off and review before merge. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md); how decisions are made and how to become a reviewer or maintainer is in
[GOVERNANCE.md](GOVERNANCE.md).

## Where to start

- **Questions and ideas:** open an issue. Check [docs/faq.md](docs/faq.md) first.
- **Bugs:** an issue with the commit, the command and the output; a failing Foundry or vitest test is ideal.
- **Design changes** (wire format, trust model, provider powers, deployment): a short proposal first, as an issue or
  a file under `docs/proposals/` (see GOVERNANCE.md).
- **Changes CLPR itself would need:** write them up under `docs/proposals/` and take them to the CLPR repositories;
  this repository never patches `lib/clpr-smart-contracts`.

## Developer Certificate of Origin (DCO)

Every commit must be signed off. The sign-off certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the change or have the right to submit it under the project's licence, and that you understand the
contribution and your sign-off are public and kept permanently. Use your real name and an e-mail address you control.

```sh
git commit -s -m "feat(router): ..."
```

This adds a trailer with your real name and e-mail:

```
Signed-off-by: Jane Doe <jane@example.org>
```

To sign off commits you already made on your branch: `git rebase --signoff main`. Pull requests with unsigned commits
cannot be merged. If a tool or assistant helped write a commit, keep your `Signed-off-by` (you certify the DCO) and add
a `Co-Authored-By:` trailer for the tool if your organisation asks for it, after your `Signed-off-by`.

Signed commits (`git commit -S`, GPG or SSH) are encouraged and are used for every maintainer commit.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, for example
`fix(router): ...`, `feat(sdk): ...`, `test(e2e): ...`, `docs: ...`, `ci: ...`. Scopes in use: `router`, `registry`,
`vault`, `codec`, `proto`, `sdk`, `services`, `registry-data`, `e2e`, `gas`, `settle`, `connector`, `deploy`. One logical change per commit; each
commit should build on its own.

## Before you open a pull request

```sh
git submodule update --init --recursive
forge fmt --check
forge build --sizes --skip 'test/**' --skip 'script/**'   # ClprRouter must stay under 24,576 B
forge test
(cd sdk && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test)
(cd services && pnpm install --frozen-lockfile && pnpm typecheck && pnpm run test:unit)
(cd services && pnpm test)        # also the anvil integration test; needs `anvil` and a prior `forge build`
```

For changes that touch routing end to end, also run `script/e2e/run.sh` (three anvil chains, about 9 minutes); for
`src/settle/` or `services/connector`, `script/settle-e2e/run.sh`. Anything that will run on Hedera should stay well
under Hedera's contract trace-size cap: `script/deploy/trace-size.mjs` estimates it
([docs/lfdt/hedera-trace-cap.md](docs/lfdt/hedera-trace-cap.md)).

CI runs the same checks plus fuzz, invariant, coverage, slither, CodeQL and a dependency audit
(`.github/workflows/`).

## Rules for changes

- **`lib/clpr-smart-contracts` stays unchanged.** CLPRouter is a CLPR application; it must not need changes to the
  CLPR Service, verifiers or Connectors.
- **Contracts are immutable once deployed.** A behaviour change to a deployed contract is a new version: bump
  `ClprRouter.VERSION` and follow `docs/deployment.md`, section 5.
- **Mind the size budget.** `ClprRouter` has about 100 B of EIP-170 margin. Move logic into `RouteLogic` or
  `RouteCodec` rather than growing the Router.
- **Tests with every change.** Contract changes name the invariants they touch (`docs/audit-readiness.md`) and add or
  update tests for them. Codec changes update the vectors on both sides (Solidity and SDK).
- **Numbers are measured.** Gas, sizes and other figures in docs come from a test, fixture or measurement in the repo.
- **No secrets.** No private keys (other than anvil's published development keys in local scripts), tokens, internal
  hostnames or local paths in committed files.
- **Docs.** Update the relevant file in `docs/` and add a line under "Unreleased" in `CHANGELOG.md`.

## Reporting security issues

Do not open an issue or pull request. Follow [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under the MIT License ([LICENSE](LICENSE)).
