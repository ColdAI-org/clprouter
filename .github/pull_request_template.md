## What and why

<!-- One paragraph. Link the issue or ADR section. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`, see CONTRIBUTING.md) and uses Conventional Commits.
- [ ] `forge fmt --check`, `forge build --sizes --skip 'test/**' --skip 'script/**'` (ClprRouter under 24,576 B) and `forge test` pass.
- [ ] `pnpm typecheck` and `pnpm test` pass in `sdk/` and `services/` if touched.
- [ ] New behaviour has tests; contract changes list the invariants they touch (docs/audit-readiness.md).
- [ ] Docs updated (README, docs/, CHANGELOG.md under "Unreleased").
- [ ] `lib/clpr-smart-contracts` is unchanged.
- [ ] No secrets, private keys, internal hostnames or local paths.

Security issues: do not open a PR. Report privately (SECURITY.md).
