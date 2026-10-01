# CLPRouter certification evidence (ISO 20022, MiCA, Energy)

The evidence the provider committee reviews before certifying networks for the CLPRouter filters, plus
draft (unsigned) `CERTIFY` decisions for the networks that meet the evidence rules. Spec:
`clprouter-spec.md`, sections *ISO 20022 filter*, *ISO network registry*, *MiCA filter*, *Network
compliance status*, *Greenest mode* and *The provider's role*. Contract: `src/ProviderRegistry.sol`.

Checked 1 October 2026. Nothing here is signed, and nothing has been submitted to any registry.

## Files

| Path | What it is |
| --- | --- |
| `build.py` | Rebuilds every output from `config/` and `sources/`. Python 3.10+ (stdlib only), `pdftotext` (poppler), Foundry `cast`. |
| `config/networks.json` | Networks (Hedera first, then the spec's compliance table), CAIP-2 ids, register search patterns, and every accept/reject rule with its reason. |
| `config/iso20022.json` | Curated ISO 20022 evidence for the provisional launch list, with sources. |
| `config/policy.json` | Proposed decision parameters (epoch, nonce start, `validUntil`, `expiry`, energy thresholds). |
| `sources/esma/*.csv` | Snapshot of ESMA's interim MiCA register, with `MANIFEST.json` (URL, sha256, size). |
| `sources/iso20022/rmg-members.json` | ISO 20022 Registration Management Group member list, parsed from a Wayback Machine snapshot. |
| `mica.json` | Per network: the native token's register entries (filer, authority, date, URL, DTI check against the register and against the paper), rejected false positives; EMT/ART issuers and their white papers. |
| `energy.json` | Per network: every white paper opened, the Part J sustainability indicators parsed from it (with page or iXBRL fact), data-quality flags, and the certifiable µgCO2e/tx figure or the reason it is null. |
| `iso20022.json` | The seven provisional ISO 20022 networks, evidence level, RMG check, criteria status. |
| `evidence/<network>.<label>.json` | The evidence record a decision commits to (canonical JSON). |
| `decisions/NNN-<network>-<label>.json` | Draft `Decision` for `ProviderRegistry.submit`, with payload, evidence hash and digest. |

White papers are not committed (third-party documents). `build.py` downloads them into `.cache/`
(git-ignored) and records each one's sha256, so a reviewer can fetch the same bytes and check them.

## Rebuild

```sh
python3 build.py                 # uses sources/esma as committed, fetches papers into .cache/
python3 build.py --refresh-esma  # re-download the five CSVs from https://www.esma.europa.eu/sites/default/files/2024-12/
python3 build.py --offline       # only .cache/ and sources/
```

The build stops with `REVIEW NEEDED` if a refreshed register contains a candidate row that no accept or
reject rule covers, or an accepted row whose DTI does not match. Add a rule to `config/networks.json` and
rerun. Outputs are deterministic for the same inputs.

## Method

### MiCA (criteria 1 and 2)

1. **Find candidates.** ESMA's `OTHER.csv` has no token-name column, so each network's regex runs over
   the white-paper URL, comments, filer name and the name of the person seeking admission to trading.
   ESMA's repeated header lines inside the CSV are dropped. `esma_row` is the record number in the file.
2. **Classify.** Every hit is accepted or rejected by an explicit rule with a written reason. Rejected
   rows stay in `mica.json` under `rejected_false_positives`.
3. **DTI check, register.** Accepted rows are compared with the token's FFG DTI (`ffg_dti` in config).
   Rows elsewhere in the register that carry one of an accepted row's DTIs are surfaced as possible
   collisions and must be classified too.
4. **DTI check, paper.** For every paper we could open, the DTI and FFG DTI printed in Part F (or the
   iXBRL facts `OtherTokenDigitalTokenIdentifierCode` / `...FunctionallyFungibleGroup...`) are compared
   with the register.
5. **Criterion 2** is met when we opened a paper whose Part J prints an energy-consumption figure (S.8).

Criteria 3 to 5 (authorised CASP operator, allowed assets, transfer data) are operator-level or enforced
by the Router at runtime; they are recorded as `met: null` in each MiCA evidence record.

**Allowed stablecoins.** `mica.json > stablecoins` lists every EMT issuer in `EMTWP.csv` with its white
papers, DTIs and a `token_hint` read from the row's URL or comment (null when the row does not name the
token). `ARTZZ.csv` is empty: no ART issuer is authorised. Tether/USDT appears in neither file.

### Energy

For each accepted register row, `build.py` resolves the URL to the paper itself (following Crypto Risk
Metrics and LCX landing pages and meta-refresh redirects) and parses Part J:

- **PDF**: `pdftotext -layout`, split by page. The Part J table is the last occurrence of each field
  label (`S.8 Energy consumption`, ..., `S.14 GHG intensity`). Three layouts are handled: value after
  the label (Crypto Risk Metrics, Kraken), value before the label (LCX), and unit printed in the label
  with a bare number (Canton). A number is taken only together with a printed unit.
- **iXBRL**: facts by ESMA taxonomy concept (`mica:GHGIntensity`, ...), converted with `unitRef` and
  `scale`.
- **Rendered XHTML tables** (Bitstamp's `assets.bitstamp.net` papers): values are recorded raw and
  never converted, because no unit is printed.

Each indicator keeps its raw text and the page (PDF) or fact id (iXBRL). The certified figure is the
paper's own **S.14 GHG intensity** converted from kg to µg (× 10⁹), never recomputed. Per paper it
is selected as follows:

- **Candidates.** A paper is a candidate if S.14 is printed with a unit, is above zero, and the paper
  has no blocking flag. For a PDF/xhtml pair of the same publication, the PDF is used: the iXBRL S.14 is
  in tonnes at 5 decimals and reads 0.00000 for every proof-of-stake chain.
- **Choice.** Among candidates, the latest disclosure period (S.7) wins, then the latest publication.
- **Precision.** `rounding_interval_ugco2e` gives the range the printed decimals allow.

Flags:

| Flag | Blocking | Meaning |
| --- | --- | --- |
| `TEMPLATE_ERROR` | yes | S.9 says the energy of another network was "calculated first" (e.g. `binance_smart_chain, klaytn` in the LCX HBAR paper). |
| `DUPLICATE_FIGURES` | yes | The same S.13 tCO2e is printed in papers for different networks. |
| `IMPLAUSIBLE_GRID_INTENSITY` | yes | (S.12+S.13)/S.8 > 1.0 kgCO2e/kWh, above any national grid average. |
| `PDF_XHTML_DISAGREE` | yes | The two formats of one publication disagree beyond rounding. |
| `SUPPLEMENTARY_INDICATORS_ABSENT` | no | Only S.8 is disclosed. |
| `DISCLOSURE_PERIOD_NOT_ONE_YEAR` | no | S.6 to S.7 is not about 12 months. |
| `NO_S8` | no | No usable energy figure. |

### ISO 20022

The direct RMG page returns HTTP 403 to scripts, so the list is parsed from the Wayback Machine
snapshot of 16 March 2026 (`sources/iso20022/rmg-members.json`, with the HTML's sha256). This confirms
what the spec states: of the launch-list networks, only Ripple (member entity "RippleNet") sits on the
RMG. Stellar (BP Ventures) and XDC (Impel) have tooling sources. Hedera, Algorand, IOTA and Cardano
are market-cited only.

### Decisions

- **Shape.** Each draft is the `IProviderRegistry.Decision` struct for `submit()`:
  - `action` = 1 (CERTIFY);
  - `payload` = `abi.encode(string ledgerId, uint8 label, uint64 expiry, uint64 emissionsUg, string emissionsSource)`;
  - `evidenceHash`, `nonce`, `effectiveAt`, `validUntil`, `epoch`.
- **Evidence hash.** `evidenceHash` = sha256 of the evidence file's bytes without the trailing newline.
- **Digest.** `digest` = `decisionDigest(d)`; `eip191_hash_to_sign` is what committee members sign.
- **Checked on a local chain.** The digests were checked against `ProviderRegistry.decisionDigest` on a
  local anvil deployment. All 43 drafts were then relayed there in nonce order with throwaway test keys
  (notice periods set to 0). `certificationAt` returned `true` and the drafted `emissionsUg` for each.
- **When a network gets a draft.** MiCA: criteria 1 and 2 are met. Energy: a certifiable S.14 figure
  exists.
- **No ISO 20022 drafts.** No network meets all four ISO registry criteria (no conformance-tested Router
  or identified operator exists yet), so `iso20022.json` records the blockers instead.

Before signing:

- renumber nonces against the live registry `version` (this changes the digest);
- confirm the CAIP-2 ids flagged "confirm before signing" (Polkadot, Cosmos Hub, Sui, Aptos, Canton);
- keep `effectiveFrom < expiry ≤ effectiveFrom + 366 days`.

## Results (build of 1 October 2026)

43 drafts: 27 MiCA, 16 Energy.

| Network | Energy µgCO2e/tx | Source, or why null |
| --- | ---: | --- |
| Hedera | null | Kraken-route paper (filed by Hedera Hashgraph LLC) discloses S.8 only (82,133.2125 kWh/yr, p.34). LCX's paper has S.14, but its S.9 names `binance_smart_chain, klaytn`, its S.10/S.13 equal LCX's XRP paper, and (S.12+S.13)/S.8 = 1.225 kgCO2e/kWh. |
| XRP Ledger | 10,000 | CRM 2026-01-06, S.14 0.00001 kg, p.46 |
| Stellar | 20,000 | CRM 2026-01-15, p.45 |
| Algorand | 10,000 | CRM 2026-04-07, p.43 |
| Cardano | 370,000 | CRM 2026-04-27, p.43 |
| Ethereum | 20,000 | CRM 2026-05-29, p.43 |
| Bitcoin | 6,376,500,000 | CRM 2026-05-26, S.14 6.37650 kg, p.43 |
| Solana, BNB, Polygon, Sui, NEAR | null | S.14 printed as 0.00000 kg |
| TRON | 10,000 | LCX v1.0, p.27; disclosure period is one day (2024-05-18) |
| Avalanche | 20,000 | CRM 2026-04-21, p.45 |
| Arbitrum | 20,000 | CRM 2026-05-05, p.43 |
| Polkadot | 10,000 | CRM 2026-07-09, p.46 |
| Cosmos Hub | 40,000 | CRM 2026-01-08, p.58 |
| Injective | 30,000 | CRM 2026-07-13, p.57 |
| Cronos | 50,000 | CRM 2026-09-01, p.69 |
| Canton | 440,000 | Canton Foundation (CCRI data), p.35; period is one day (2025-08-28) |
| Aptos | 50,000 | CRM 2026-01-29, p.40 |
| TON | 10,000 | CRM "Gram" 2026-08-03, p.47 |
| OP, Mantle, ZKsync, Flare, Bittensor | null | No usable S.14 (S.8-only papers, or Bitstamp tables without units, or OKX's iXBRL scale conflict) |
| dYdX | null | CRM pages link no document |
| XDC, IOTA, THORChain, Starknet, Gnosis | null | No MiCA white paper in the register |

## Caveats for the committee

1. **Hedera has no certifiable Energy figure.** Every route passes through Hiero, so the Energy filter
   returns no routes until Hedera is certified. Next step: ask Hedera or Kraken for a paper with the
   full S.10–S.16 set, or use the spec's fallback, an independent provider such as CCRI, labelled as
   such.
2. **Marginal, not allocated.** Crypto Risk Metrics' S.16 says S.14 is "the marginal emission intensity
   with respect to one additional transaction". The spec's Greenest mode assumes an allocation (network
   total ÷ transactions). Canton's (CCRI) and LCX's papers do not call their S.14 marginal, so ranking
   them together with CRM figures may not be like-for-like.
3. **Precision.** S.14 is printed to 5 decimals of a kilogram, a resolution of 10,000 µg. XRPL, Algorand,
   Polkadot, TON and TRON (10,000 µg) could truly be anywhere in 5,000–15,000 µg. Five networks read as
   0 and cannot be certified, since the registry requires `emissionsUg > 0`. Greenest cannot reliably
   rank these networks against each other.
4. **LCX papers.** Systematic copy-paste errors:
   - S.9 names the wrong networks;
   - 100.59130 tCO2e appears in both HBAR and XRP;
   - 1873.14310 tCO2e and 14.770208242 % appear in the SOL, AVAX, DOT and TON papers.

   Only the TRON paper passed the checks; its period fields (one day, 2024) are also suspect.
5. **Shared renewable share.** CRM prints the same renewable share (37.91241011 %, to 8 decimals) for
   Ethereum, Algorand, Arbitrum, Sui and TON. Its S.15 explains that reference networks are used where node
   locations are unknown, so S.10 is often not network-specific.
6. **Stale disclosure periods.** CRM's 2026 Ethereum and Bitcoin papers still disclose the period ending
   2025-03-22.
7. **DTI checks are consistency checks only.** The DTI Foundation registry API needs a key, so DTIs were
   not checked against DTIF. Hedera's two papers print different DTIs (2WWB8QS47 vs DHQPD433B), and the
   register rows carry none. False positives caught by DTI:
   - Bitcoin HT's "BTC" paper (DTI QJJ02KRR0);
   - DuckChain carrying TON's DTI;
   - OneFootball carrying ETH's DTI.
8. **Papers not opened:**
   - `www.bitstamp.net` blocks scripted downloads (Incapsula), so the Bitstamp TRX, POL, ATOM and APT
     papers were not read;
   - `trondao.org/files/TRX-MiCA_Whitepaper.pdf` (Tron Tech) and `lcx.com/mnt-mica-white-paper` return
     404;
   - ZKsync Association (`zknation.io`), Injective Foundation and Sui Foundation (`onetrading.com/policy`)
     register a home page, not the paper.
9. **Short-form papers.** Hedera (Kraken), OP, Arbitrum (LCX), Polygon (LCX) and Bittensor disclose S.8
   only. Polygon Labs' own paper prints "< 500'000 kWh per year". We read this as the Delegated
   Regulation (EU) 2025/422 threshold for the supplementary indicators; the committee should confirm
   that reading. OKX's Bittensor paper labels S.8 in kWh but tags it `scale="3"`, so the value is left
   null.
10. **Differences from the spec's compliance table:**
    - extra filers: Polygon Labs (POL), Bitstamp (MNT, ZK), Sui Foundation (SUI), and CRM's "Gram"
      re-filing of Toncoin;
    - `CASPS.csv` has 364 rows (358 distinct LEIs), not the 433 the spec states.

    Everything else in the table (including "no entry" for XDC, IOTA, THORChain, Starknet and Gnosis, and
    the gno.land false positive) is confirmed.
11. **EMT token hints** come from register URLs and comments. The register gives no contract addresses,
    so the Router's allow-list still needs per-ledger addresses from each issuer's white paper.
