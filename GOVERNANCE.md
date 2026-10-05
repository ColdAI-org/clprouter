# Governance

CLPRouter is an open-source application built on [CLPR](https://github.com/LFDT-CLPR), maintained by
[ColdAI](https://coldai.org). It is not an LF Decentralized Trust project. This file says who decides what, and how
anyone, including the LFDT CLPR community, can take part.

## Roles

| Role | Who | What they do |
| --- | --- | --- |
| Contributor | Anyone who opens an issue, a discussion or a pull request | Proposes changes; every commit carries a DCO sign-off ([CONTRIBUTING.md](CONTRIBUTING.md)) |
| Reviewer | Contributors with a record of good reviews, named by the maintainers | Reviews pull requests in their area; their approval counts toward merging off-chain code |
| Maintainer | Listed below | Merges pull requests, cuts releases, handles private reports made under SECURITY.md, keeps this file current |

### Maintainers

| Name | GitHub | Areas |
| --- | --- | --- |
| Schayan Salehi (ColdAI) | [@shayansal](https://github.com/shayansal) | All |

We want more maintainers, including from outside ColdAI. A contributor becomes a maintainer after sustained,
high-quality contributions and reviews, on the proposal of a maintainer and with no objection from the others within
7 days. A maintainer who is inactive for 6 months becomes emeritus; they can return the same way.

## How decisions are made

- **Day to day: lazy consensus on pull requests.** A pull request merges once a maintainer approves it, CI is green
  and no maintainer has an open objection. The author does not approve their own change while there are other
  maintainers.
- **Contract changes need more.** Anything under `src/` that changes on-chain behaviour needs two approvals (one of
  them a maintainer) once the project has more than one maintainer, names the invariants it touches
  ([docs/audit-readiness.md](docs/audit-readiness.md)) and comes with tests. Deployed contracts are immutable, so a
  behaviour change is a new Router version ([docs/deployment.md](docs/deployment.md), section 5).
- **Design changes are written down first.** A change to the wire format, the trust model, the provider's powers or
  the deployment process starts as a short proposal (an issue, or a file under `docs/proposals/`) and is discussed for
  at least 7 days before a pull request implements it.
- **Disagreements** are settled by discussion; if that fails, by a simple majority of maintainers, with the
  reasoning recorded in the issue or pull request.
- **Private reports** made under [SECURITY.md](SECURITY.md) are handled by the maintainers out of public view;
  fixes may merge before the public explanation.

## What is decided elsewhere

- **The CLPR protocol, Service, verifiers and Connectors** belong to the CLPR project under LF Decentralized Trust.
  CLPRouter treats `lib/clpr-smart-contracts` as read-only. When we need a protocol or verifier change, we write it
  up under [`docs/proposals/`](docs/proposals) and take it to the CLPR project under its own process; we do not fork
  CLPR behaviour into this repository.
- **The provider committee** of a production deployment (certifications, disables, blacklist) is a separate body
  with its own runbook ([docs/provider-committee-runbook.md](docs/provider-committee-runbook.md)). Repository
  maintainers have no on-chain powers: the Routers have no admin key, and the committee's powers are limited by the
  contracts.

## How the LFDT and CLPR community can participate

- Open issues and pull requests here, including against the docs and the proposals in
  [`docs/proposals/`](docs/proposals).
- Review the upstream proposals we bring to CLPR (see [docs/lfdt/briefing.md](docs/lfdt/briefing.md)) in the CLPR
  repositories, where they will be decided.
- Use CLPRouter as an integration test bed for CLPR releases; we will add CI jobs against CLPR branches on request.
- Become a reviewer or maintainer through the path above.
- If LF Decentralized Trust wants to host CLPRouter as a lab or reference application, the maintainers will follow
  the LFDT process and adapt this file, the licence and the contribution rules as it requires.

## Changing this file

Changes to this file follow the design-change rule above (written proposal, 7 days) and need the approval of a
majority of maintainers.
