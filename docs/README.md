# CLPRouter documentation

| Document | For | Covers |
| --- | --- | --- |
| [Integrator guide](integrator-guide.md) | Application developers | Plan and send a route, receive one, read receipts, handle `QUARANTINED`, ISO 20022 routes |
| [Operator guide](operator-guide.md) | Pumpers, Connector and endpoint operators, services operators, regulated operators | Roles, running the services and the container, pumping pending hops, keys |
| [Provider committee runbook](provider-committee-runbook.md) | Committee members | Signing format, HSM key ceremony, k-of-n decisions, rotation, emergency disable, blacklist and vault releases, legal review gate |
| [Deployment guide](deployment.md) | Maintainers | Contracts and parameters per ledger, networks and addresses, upgrades by deploying a new version |
| [Settle on Hedera](settle-on-hedera.md) | Integrators, Connector operators, auditors | Bonded Connectors with the guarantee on Hedera: contracts, quote format, order states, bonds, Hedera limits, gas, tests, gaps |
| [Threat model](threat-model.md) | Everyone, auditors | Assets, actors, trust tiers, attack surfaces, mitigations, residual risks |
| [Audit-readiness pack](audit-readiness.md) | Auditors | Scope, invariants, known issues, test counts and coverage |
| [FAQ](faq.md) | Everyone | Short answers: trust, provider powers, failures, testnet status, Hedera limits, audits |
| [Briefing for the LFDT CLPR maintainers](lfdt/briefing.md) | CLPR maintainers | What CLPRouter is, what is verified, proposed upstream contributions, questions, demo script |
| [Hedera trace-size cap](lfdt/hedera-trace-cap.md) | CLPR verifier authors, Hiero | `contracts.maxSerializedTraceDataBytes`: evidence, reproduction, impact on large-calldata verifiers |
| [Proposal: staged ETH committee](proposals/clpr-staged-eth-committee.md) | CLPR maintainers | Staged sync-committee configuration and rotation for `EthMainnetVerifier` on Hedera |

Also in the repository:

- [`README.md`](../README.md): what CLPRouter is, what runs on testnet (with transaction links), architecture,
  modes and filters, quick start, security and audit status, roadmap.
- [`deployments/README.md`](../deployments/README.md): the Sepolia and Hedera testnet deployment, every transaction.
- [`sdk/README.md`](../sdk/README.md): the planner SDK and the ISO 20022 module.
- [`registry-data/README.md`](../registry-data/README.md): certification evidence and draft committee decisions.
- [`proto/clprouter/v1/route_envelope.proto`](../proto/clprouter/v1/route_envelope.proto): the wire format.
- [`SECURITY.md`](../SECURITY.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`GOVERNANCE.md`](../GOVERNANCE.md),
  [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md), [`CHANGELOG.md`](../CHANGELOG.md).
- `docs/audit/`: auditors' working area (owned by the auditors).
