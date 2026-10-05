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
| [Engineering quality](quality.md) | Everyone, auditors, reviewers | Test counts, halmos proofs (what is proven, what is fuzzed), 10,000-run fuzzing, coverage, gas snapshot, contract sizes, slither and Aderyn triage, dependency audit |

Also in the repository:

- [`README.md`](../README.md): what CLPRouter is, architecture, gas, the Hiero end-to-end run.
- [`sdk/README.md`](../sdk/README.md): the planner SDK and the ISO 20022 module.
- [`registry-data/README.md`](../registry-data/README.md): certification evidence and draft committee decisions.
- [`proto/clprouter/v1/route_envelope.proto`](../proto/clprouter/v1/route_envelope.proto): the wire format.
- [`SECURITY.md`](../SECURITY.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`CHANGELOG.md`](../CHANGELOG.md).
- `docs/audit/`: auditors' working area (owned by the auditors).
