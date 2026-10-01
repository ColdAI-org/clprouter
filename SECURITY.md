# Security policy

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, pull request or discussion.

- E-mail: **security@REPLACE-WITH-PROVIDER-DOMAIN** (placeholder: the maintainers set the real address before the
  first public release)
- Or use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability").

Please include: the affected file and commit, a description, the impact you expect, and a proof of concept (a Foundry
test is ideal). Encrypt sensitive details if you can; the maintainers publish a PGP key alongside the address.

We aim to acknowledge within 3 working days, give a first assessment within 10 working days, and agree a disclosure
date with you. We credit reporters who want credit.

## Scope

| In scope | Out of scope |
| --- | --- |
| `src/` (Router, registry, vault, libraries, interfaces) | `lib/clpr-smart-contracts`: report to the CLPR project (LFDT-CLPR) under its own policy |
| `proto/` and the codecs in `src/libraries/RouteCodec.sol` and `sdk/src/` | Test helpers, scripts and fixtures |
| `sdk/` (planner, envelope builder, ISO 20022 module) | Third-party dependencies, unless CLPRouter uses them unsafely |
| `services/` and the release container image | Issues already listed in `docs/threat-model.md` section 7, unless you show a worse impact |
| CI and release workflows in `.github/` | Social engineering, physical attacks, denial of service by volume |

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes (local networks and testnets only; not deployed on any mainnet) |

## How fixes ship

The contracts are immutable. A fix to an on-chain bug ships as a new Router version deployed beside the old one; the
provider committee can disable an unsafe version (`docs/deployment.md`, section 5). Off-chain fixes ship as new SDK
and services releases.
