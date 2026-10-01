#!/usr/bin/env python3
"""Rebuild the CLPRouter certification evidence dataset (ISO 20022, MiCA, Energy).

Usage:
    python3 build.py                 # rebuild everything from sources/ (fetches white papers into .cache/)
    python3 build.py --refresh-esma  # re-download ESMA's interim MiCA register CSVs first
    python3 build.py --offline       # use only .cache/ and sources/; fail if something is missing

Requires: Python >= 3.10 (stdlib only), `pdftotext` (poppler) and Foundry's `cast` (ABI encoding, keccak256).

Outputs (all deterministic for the same inputs):
    mica.json, energy.json, iso20022.json, evidence/*.json, decisions/*.json,
    sources/esma/MANIFEST.json, sources/iso20022/rmg-members.json

Rules: no figure is ever typed in by hand. Every number in energy.json is parsed from a white paper and
carries its document hash and page (PDF) or iXBRL fact id (xhtml). Anything that cannot be parsed is null
with a reason.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
ESMA_DIR = ROOT / "sources" / "esma"
ISO_DIR = ROOT / "sources" / "iso20022"
ESMA_BASE = "https://www.esma.europa.eu/sites/default/files/2024-12/"
ESMA_FILES = {
    "OTHER": "White papers for crypto-assets other than ARTs and EMTs",
    "CASPS": "Authorised crypto-asset service providers",
    "EMTWP": "E-money token white papers (issuers of EMTs)",
    "ARTZZ": "Issuers of asset-referenced tokens",
    "NCASP": "Non-compliant entities providing crypto-asset services",
}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
OFFLINE = False


# ── helpers ──────────────────────────────────────────────────────────────────

def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def canonical(obj) -> bytes:
    """Canonical JSON used for evidence hashing: sorted keys, no insignificant whitespace, UTF-8."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fetch(url: str, timeout: int = 120) -> tuple[bytes, str]:
    """GET with an on-disk cache keyed by URL. Returns (body, final_url)."""
    key = sha256_bytes(url.encode())
    body_p, meta_p = CACHE / "http" / key, CACHE / "http" / (key + ".json")
    if body_p.exists() and meta_p.exists():
        return body_p.read_bytes(), load_json(meta_p)["final_url"]
    if OFFLINE:
        raise RuntimeError(f"offline and not cached: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body, final = r.read(), r.geturl()
    body_p.parent.mkdir(parents=True, exist_ok=True)
    body_p.write_bytes(body)
    write_json(meta_p, {"url": url, "final_url": final, "fetched": now_iso()})
    return body, final


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_date(s: str) -> str | None:
    s = (s or "").strip()
    for fmt in ("%d/%m/%Y", "%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


# ISO 24165 DTIs are 9 characters from 0-9 and the consonants B-Z (no vowels), so ordinary words never match.
DTI_RE = re.compile(r"\b[0-9B-DF-HJ-NP-TV-Z]{9}\b")


def parse_dtis(s: str) -> list[str]:
    """DTIs are 9-character codes. Register cells separate them with '|', ';', ',', spaces or ' I '."""
    return sorted(set(DTI_RE.findall((s or "").upper())))


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()


# ── ESMA register ────────────────────────────────────────────────────────────

def esma_refresh(refresh: bool) -> dict:
    ESMA_DIR.mkdir(parents=True, exist_ok=True)
    manifest_p = ESMA_DIR / "MANIFEST.json"
    old = load_json(manifest_p) if manifest_p.exists() else {"files": {}}
    files = {}
    for name, desc in ESMA_FILES.items():
        p = ESMA_DIR / f"{name}.csv"
        url = ESMA_BASE + f"{name}.csv"
        if refresh:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                p.write_bytes(r.read())
        if not p.exists():
            raise SystemExit(f"missing {p}; run with --refresh-esma")
        b = p.read_bytes()
        prev = old["files"].get(name, {})
        retrieved = now_iso() if refresh or prev.get("sha256") != sha256_bytes(b) else prev.get("retrieved")
        files[name] = {"description": desc, "url": url, "sha256": sha256_bytes(b), "bytes": len(b),
                       "retrieved": retrieved}
    manifest = {"source": "ESMA interim MiCA register", "files": files}
    write_json(manifest_p, manifest)
    return manifest


def read_register(name: str) -> list[dict]:
    """Rows of one ESMA CSV, with ESMA's repeated header lines dropped. `_row` = 1-based record number."""
    text = (ESMA_DIR / f"{name}.csv").read_text(encoding="utf-8-sig")
    rows = []
    for i, r in enumerate(csv.DictReader(io.StringIO(text)), start=1):
        first = next(iter(r))
        if (r.get(first) or "").strip() == first:  # embedded header line
            continue
        r = {k: (v or "").strip() for k, v in r.items() if k}
        r["_row"] = i
        rows.append(r)
    return rows


# ── white paper documents ────────────────────────────────────────────────────

LANDING_LINKS = [
    re.compile(r'https://white-paper\.crypto-risk-metrics\.com/[^"\'\s<>]+?\.(?:pdf|xhtml)'),
    re.compile(r'(?:https://crypto-risk-metrics\.com)?/wp-content/uploads/[^"\'\s<>]*White-paper[^"\'\s<>]*?\.(?:pdf|xhtml)'),
    re.compile(r'https://wp\.lcx\.com/wp-content/uploads/[^"\'\s<>]+?\.pdf'),
]
META_REFRESH = re.compile(r'<meta[^>]+http-equiv="refresh"[^>]+url=([^"\'>]+)', re.I)


def normalise_url(u: str) -> str | None:
    u = (u or "").strip().split()[0] if (u or "").strip() else ""
    if not u:
        return None
    u = u.rstrip(".")
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    return u


def kind_of(body: bytes) -> str:
    head = body[:2048].lstrip()
    if body[:5] == b"%PDF-":
        return "pdf"
    if b"<ix:non" in body:
        return "ixbrl"
    if re.search(rb'<td[^>]*\bid="EnergyConsumption"', body):
        return "xhtml-table"
    if head[:1] == b"<":
        return "html"
    return "other"


def resolve_documents(url: str, depth: int = 0) -> tuple[list[dict], str | None]:
    """Turn a register URL into white-paper documents. Landing pages are followed one level for known
    publishers (Crypto Risk Metrics, LCX); meta-refresh redirects are followed. Returns (documents, problem)."""
    try:
        body, final = fetch(url)
    except Exception as e:  # noqa: BLE001
        return [], f"fetch failed: {e.__class__.__name__}: {e}"
    k = kind_of(body)
    if k == "html" and b"_Incapsula_Resource" in body:
        return [], "blocked by the publisher's bot protection (Incapsula) for scripted downloads; fetch in a browser and add to .cache manually"
    m = META_REFRESH.search(body[:5000].decode("utf-8", "ignore"))
    if k == "html" and m and depth < 3:
        return resolve_documents(urllib.parse.urljoin(final, html.unescape(m.group(1).strip())), depth + 1)
    if k in ("pdf", "ixbrl", "xhtml-table"):
        return [{"url": url, "final_url": final, "kind": k, "body": body, "via": "register URL"}], None
    if k != "html":
        return [], f"register URL returned unsupported content ({k})"
    text = body.decode("utf-8", "ignore")
    links = []
    for rx in LANDING_LINKS:
        links += [html.unescape(m) for m in rx.findall(text)]
    links = sorted({urllib.parse.urljoin(final, l) for l in links})
    if not links:
        return [], "register URL is a web page with no white-paper document linked from it"
    docs = []
    for link in links:
        try:
            b, f = fetch(link)
        except Exception as e:  # noqa: BLE001
            docs.append({"url": link, "kind": "error", "error": str(e), "via": f"linked from {url}"})
            continue
        docs.append({"url": link, "final_url": f, "kind": kind_of(b), "body": b, "via": f"linked from {url}"})
    return docs, None


def pdf_pages(body: bytes) -> list[str]:
    p = CACHE / "pdf" / (sha256_bytes(body) + ".pdf")
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_bytes(body)
    out = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True).stdout.decode("utf-8", "ignore")
    pages = out.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return pages


def norm_text(s: str) -> str:
    return (s.replace("​", "").replace("CO₂", "CO2").replace(" ", " ").replace("–", "-"))


NUM = r"(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
VALUE_RX = {
    "S.6": re.compile(r"(\d{4}-\d{2}-\d{2})"),
    "S.7": re.compile(r"(\d{4}-\d{2}-\d{2})"),
    "S.8": re.compile(NUM + r"\s*kWh(?:\s*kWh)?\s*(?:/\s*a\b|/\s*year|per\s+year|p\.a\.)", re.I),
    "S.10": re.compile(NUM + r"\s*%"),
    "S.11": re.compile(NUM + r"\s*kWh(?!\s*/\s*a\b)(?!\s*per\s+year)", re.I),
    "S.12": re.compile(NUM + r"\s*(t)\s*CO2e?", re.I),
    "S.13": re.compile(NUM + r"\s*(t)\s*CO2e?", re.I),
    "S.14": re.compile(NUM + r"\s*(kg|g|t)\s*CO2e?", re.I),
}
LABEL_RX = {
    "S.3": re.compile(r"S\.3\.?\s+Name of"),
    "S.6": re.compile(r"S\.6\.?\s+Beginning"),
    "S.7": re.compile(r"S\.7\.?\s+End of"),
    "S.8": re.compile(r"S\.8\.?\s+Energy\s+consumption(?!\s+sources)", re.I),
    "S.9": re.compile(r"S\.9\.?\s+Energy\s+consumption\s+sources", re.I),
    "S.10": re.compile(r"S\.10\.?\s+Renewable", re.I),
    "S.11": re.compile(r"S\.11\.?\s+Energy\s+intensity", re.I),
    "S.12": re.compile(r"S\.12\.?\s+Scope\s*1", re.I),
    "S.13": re.compile(r"S\.13\.?\s+Scope\s*2", re.I),
    "S.14": re.compile(r"S\.14\.?\s+GHG\s+intensity", re.I),
    "S.15": re.compile(r"S\.15\.?\s+Key\s+energy", re.I),
    "S.16": re.compile(r"S\.16\.?\s+Key\s+GHG", re.I),
}
LABEL_UNIT_RX = {
    "S.8": re.compile(r"in\s+kWh", re.I),
    "S.10": re.compile(r"in\s+%"),
    "S.11": re.compile(r"in\s+kWh", re.I),
    "S.12": re.compile(r"in\s+(t)\s*CO2", re.I),
    "S.13": re.compile(r"in\s+(t)\s*CO2", re.I),
    "S.14": re.compile(r"in\s+(kg|g|t)\s*CO2", re.I),
}
FIELDS = ["S.6", "S.7", "S.8", "S.10", "S.11", "S.12", "S.13", "S.14"]
FIELD_NAMES = {
    "S.6": "Beginning of the period to which the disclosure relates",
    "S.7": "End of the period to which the disclosure relates",
    "S.8": "Energy consumption",
    "S.10": "Renewable energy consumption",
    "S.11": "Energy intensity",
    "S.12": "Scope 1 DLT GHG emissions - Controlled",
    "S.13": "Scope 2 DLT GHG emissions - Purchased",
    "S.14": "GHG intensity",
}
TOC_RX = re.compile(r"(\.{4,}|\s{2,}\d{1,3}\s*$)")


def to_decimal(s: str) -> Decimal:
    return Decimal(s.replace(",", ""))


def extract_pdf(pages: list[str]) -> dict:
    lines = []  # (page_no, text)
    for pno, page in enumerate(pages, start=1):
        for ln in norm_text(page).split("\n"):
            lines.append((pno, ln))
    label_idx = {}
    for f, rx in LABEL_RX.items():
        # The last occurrence is the Part J table (tables of contents come first).
        hits = [i for i, (_, ln) in enumerate(lines) if rx.search(ln)]
        if hits:
            label_idx[f] = hits[-1]
    all_labels = sorted(label_idx.values())

    def window(i: int, direction: str) -> list[int]:
        if direction == "after":
            nxt = [j for j in all_labels if j > i]
            end = min(nxt[0] if nxt else len(lines), i + 12)
            return list(range(i, end))
        prv = [j for j in all_labels if j < i]
        start = max(prv[-1] + 1 if prv else 0, i - 12)
        return list(range(start, i))

    def find(f: str, direction: str):
        i = label_idx.get(f)
        if i is None:
            return None
        idxs = window(i, direction)
        if direction == "before":
            idxs = list(reversed(idxs))
        for j in idxs:
            m = VALUE_RX[f].search(lines[j][1])
            if m:
                return {"raw": m.group(0).strip(), "number": m.group(1), "unit": (m.group(2) if m.lastindex and m.lastindex >= 2 else None),
                        "page": lines[j][0], "label_page": lines[i][0], "line": lines[j][1].strip()}
        return None

    def find_label_unit(f: str):
        """Layout where the unit is part of the label ('S.14 GHG intensity ... in kg CO2eq') and the
        value is a bare number at the end of the label line (e.g. Canton Foundation's paper)."""
        i = label_idx.get(f)
        if i is None:
            return None
        if f in ("S.6", "S.7"):
            return find(f, "after")
        nxt = [j for j in all_labels if j > i]
        block = " ".join(ln for _, ln in lines[i:min(nxt[0] if nxt else i + 8, i + 8)])
        um = LABEL_UNIT_RX[f].search(block)
        m = re.search(r"\s{2,}" + NUM + r"\s*$", lines[i][1])
        if not (um and m):
            return None
        return {"raw": m.group(1), "number": m.group(1), "unit": um.group(1) if um.lastindex else None,
                "page": lines[i][0], "label_page": lines[i][0], "line": lines[i][1].strip(), "unit_from_label": um.group(0)}

    orientation = None
    if "S.8" in label_idx:
        if find("S.8", "after"):
            orientation = "after"
        elif find("S.8", "before"):
            orientation = "before"
        elif find_label_unit("S.8"):
            orientation = "label-unit"
    values = {}
    for f in FIELDS:
        if orientation == "label-unit":
            values[f] = find_label_unit(f)
        else:
            values[f] = find(f, orientation) if orientation else None
    s9 = s16 = ""
    if "S.9" in label_idx:
        a = label_idx["S.9"]
        nxt = [j for j in all_labels if j > a]
        s9 = " ".join(ln for _, ln in lines[a:(nxt[0] if nxt else a + 60)])
    if "S.16" in label_idx:
        a = label_idx["S.16"]
        s16 = " ".join(ln for _, ln in lines[a:a + 40])
    s3 = ""
    if "S.3" in label_idx:
        a = label_idx["S.3"]
        s3 = " ".join(ln.strip() for _, ln in lines[max(0, a - 1):a + 3])
    return {"labels_found": sorted(label_idx, key=lambda k: int(k[2:])), "orientation": orientation, "values": values,
            "s9_text": re.sub(r"\s+", " ", s9), "s16_text": re.sub(r"\s+", " ", s16), "s3_text": re.sub(r"\s+", " ", s3),
            "dtis": find_paper_dtis(lines)}


def find_paper_dtis(lines) -> dict:
    """DTI codes printed in the paper's 'Digital Token Identifier' fields (Part F). The FFG field is told apart
    by the words 'Functionally Fungible'."""
    out = {"dti": [], "ffg": []}
    for i, (_, ln) in enumerate(lines):
        two = (lines[i - 1][1] + " " + ln) if i else ln
        if "identifier" not in ln.lower() or not re.search(r"token\s+identifier", two, re.I) or TOC_RX.search(ln):
            continue
        if re.search(r"FFG DTI\)|mappings|we used|is used|according to", ln, re.I):
            continue
        ctx = " ".join(l for _, l in lines[max(0, i - 3):i + 1])
        if re.search(r"functionally\s+fungible", ctx, re.I) and not re.search(r"functionally\s+fungible", " ".join(l for _, l in lines[max(0, i - 3):i + 1][-3:]), re.I):
            pass
        is_ffg = bool(re.search(r"functionally\s+fungible", ctx, re.I))
        for j in range(i, min(i + 6, len(lines))):
            if j > i and re.search(r"token\s+identifier|^\s*F\.\d+", lines[j][1], re.I):
                break
            codes = DTI_RE.findall(lines[j][1].upper())
            codes = [c for c in codes if not re.match(r"^\d+$", c)]
            if codes:
                (out["ffg"] if is_ffg else out["dti"]).extend(codes)
                break
    return {k: sorted(set(v)) for k, v in out.items()}


IX_FACT = re.compile(r"<ix:(nonFraction|nonNumeric)\b([^>]*)>(.*?)</ix:\1>", re.S)


CONCEPTS = {
    "S.3": "NameOfCryptoAssetSustainability",
    "S.6": "BeginningOfPeriodToWhichDisclosedInformationRelates",
    "S.7": "EndOfPeriodToWhichDisclosedInformationRelates",
    "S.8": "EnergyConsumption",
    "S.9": "DescriptionOfEnergyConsumptionSourcesAndMethodologiesExplanatory",
    "S.10": "RenewableEnergyConsumptionPercentage",
    "S.11": "EnergyIntensity",
    "S.12": "Scope1DLTGHGEmissionsControlled",
    "S.13": "Scope2DLTGHGEmissionsPurchased",
    "S.14": "GHGIntensity",
    "S.16": "DescriptionOfKeyGHGSourcesAndMethodologiesExplanatory",
    "F.13": "OtherTokenDigitalTokenIdentifierCode",
    "F.14": "OtherTokenFunctionallyFungibleGroupDigitalTokenIdentifier",
}


def extract_ixbrl(body: bytes) -> dict:
    """Facts are found by their ESMA MiCA taxonomy concept name (mica:EnergyConsumption, ...), so the
    filer's own fact ids do not matter. The fact id is kept as the citation."""
    t = body.decode("utf-8", "ignore")
    facts = {}
    for m in IX_FACT.finditer(t):
        attrs = m.group(2)
        name = re.search(r'\bname="(?:[a-z0-9-]+:)?([^"]+)"', attrs)
        fid = re.search(r'\bid="([^"]+)"', attrs)
        if not name:
            continue
        val = html.unescape(re.sub(r"<[^>]+>", " ", m.group(3)))
        val = re.sub(r"\s+", " ", val).strip()
        a = dict(re.findall(r'\b(unitRef|decimals|scale|sign|format)="([^"]+)"', attrs))
        facts.setdefault(name.group(1), {"value": val, "id": fid.group(1) if fid else None, **a})
    values = {}
    for f in FIELDS:
        fx = facts.get(CONCEPTS[f])
        if not fx or not fx["value"]:
            values[f] = None
            continue
        values[f] = {"raw": fx["value"], "number": fx["value"], "unit": (fx.get("unitRef") or "").lower() or None,
                     "scale": int(fx.get("scale", "0") or 0), "sign": fx.get("sign"),
                     "ixbrl_fact": fx["id"], "ixbrl_concept": "mica:" + CONCEPTS[f]}
    g = lambda k: (facts.get(CONCEPTS[k]) or {}).get("value", "")  # noqa: E731
    return {"labels_found": sorted([f for f in FIELDS if values.get(f)], key=lambda k: int(k[2:])), "orientation": "ixbrl",
            "values": values, "s9_text": g("S.9"), "s16_text": g("S.16"), "s3_text": g("S.3"),
            "dtis": {"dti": parse_dtis(g("F.13")), "ffg": parse_dtis(g("F.14"))}}


TD_CELL = re.compile(r'<td[^>]*\bid="([A-Za-z0-9]+)"[^>]*>(.*?)</td>', re.S)


def extract_table(body: bytes) -> dict:
    """Rendered (non-tagged) XHTML where each value cell carries the taxonomy concept as its id
    (Bitstamp's papers). These pages print no units, so values are kept raw and never converted."""
    t = re.sub(r"url\(data:[^)]*\)", "", body.decode("utf-8", "ignore"))
    cells = {}
    for m in TD_CELL.finditer(t):
        v = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(2)))).strip()
        cells.setdefault(m.group(1), v)
    values = {}
    for f in FIELDS:
        v = cells.get(CONCEPTS[f]) or cells.get(CONCEPTS[f].replace("Percentage", ""))
        values[f] = {"raw": v, "number": v, "unit": None, "cell_id": CONCEPTS[f]} if v else None
    g = lambda k: cells.get(CONCEPTS[k], "")  # noqa: E731
    dti_cell = next((v for k, v in cells.items() if k.endswith("DigitalTokenIdentifierCode")), "")
    ffg_cell = next((v for k, v in cells.items() if k.endswith("FunctionallyFungibleGroupDigitalTokenIdentifier")), "")
    if not dti_cell:  # fall back to the text following the F.13 label
        m = re.search(r"Digital token identifier code used.*?</td>\s*<td[^>]*>(.*?)</td>", t, re.S | re.I)
        dti_cell = re.sub(r"<[^>]+>", " ", m.group(1)) if m else ""
    if not ffg_cell:
        m = re.search(r"Functionally fungible group digital token identifier.*?</td>\s*<td[^>]*>(.*?)</td>", t, re.S | re.I)
        ffg_cell = re.sub(r"<[^>]+>", " ", m.group(1)) if m else ""
    return {"labels_found": sorted([f for f in FIELDS if values.get(f)], key=lambda k: int(k[2:])), "orientation": "table-no-units",
            "values": values, "s9_text": g("S.9"), "s16_text": g("S.16"), "s3_text": g("S.3"),
            "dtis": {"dti": parse_dtis(dti_cell), "ffg": parse_dtis(ffg_cell)}}


UNIT_NAMES = {"S.8": "kWh per year", "S.10": "percent of energy from renewable sources", "S.11": "kWh per transaction",
              "S.12": "tCO2e per year", "S.13": "tCO2e per year", "S.14": "kgCO2e per transaction"}


def normalise_values(ex: dict, kind: str) -> dict:
    """Convert parsed strings into the dataset's units: kWh/year, %, kWh/tx, tCO2e/year, kgCO2e/tx.
    A value is converted only when its unit is printed (PDF text, PDF label, or iXBRL unitRef)."""
    out = {}
    for f in FIELDS:
        v = ex["values"].get(f)
        if not v:
            out[f] = None
            continue
        rec = {"raw": v["raw"]}
        if kind == "pdf":
            rec["page"] = v["page"]
            if v.get("label_page") != v["page"]:
                rec["label_page"] = v["label_page"]
            if v.get("unit_from_label"):
                rec["unit_printed_in_label"] = v["unit_from_label"]
        elif kind == "ixbrl":
            rec["ixbrl_fact"] = v["ixbrl_fact"]
            rec["ixbrl_concept"] = v["ixbrl_concept"]
        else:
            rec["cell_id"] = v["cell_id"]
        if f in ("S.6", "S.7"):
            m = re.search(r"\d{4}-\d{2}-\d{2}", v["number"] or "")
            rec["value"] = m.group(0) if m else None
            out[f] = rec
            continue
        if kind == "xhtml-table":
            rec["value"] = None
            rec["problem"] = "unit not printed next to the value; not converted"
            out[f] = rec
            continue
        try:
            d = to_decimal(v["number"])
        except (InvalidOperation, TypeError, AttributeError):
            rec["value"] = None
            rec["problem"] = "not a number"
            out[f] = rec
            continue
        unit = (v.get("unit") or "").lower()
        if kind == "ixbrl":
            fact = d.scaleb(v.get("scale") or 0)
            if v.get("sign") == "-":
                fact = -fact
            expected = {"S.8": "kwh", "S.11": "kwh", "S.12": "tco2", "S.13": "tco2", "S.14": "tco2", "S.10": "pure"}[f]
            if expected not in unit:
                rec["value"] = None
                rec["problem"] = f"unexpected unitRef {unit!r}"
                out[f] = rec
                continue
            if f != "S.10" and (v.get("scale") or 0) != 0:
                rec["value"] = None
                rec["problem"] = (f"ambiguous: displayed {d} but tagged with scale={v['scale']} (= {fact} {unit}); "
                                  "the page label and the iXBRL tag disagree, so no value is taken")
                out[f] = rec
                continue
            val = fact * 1000 if f == "S.14" else (fact * 100 if f == "S.10" else fact)
            rec["ixbrl_unit"] = unit
        else:
            factor = Decimal(1)
            if f == "S.14":
                factor = {"kg": Decimal(1), "g": Decimal("0.001"), "t": Decimal(1000)}[unit]
            val = d * factor
        rec["value"] = str(val)
        rec["unit"] = UNIT_NAMES[f]
        if f == "S.14":
            rec["printed_decimals"] = max(0, -d.as_tuple().exponent)
            rec["printed_unit"] = ("t" if kind == "ixbrl" else unit) + "CO2e"
        out[f] = rec
    return out


# ── stages ───────────────────────────────────────────────────────────────────

def row_summary(r: dict, filer_casp_note: bool = True) -> dict:
    return {
        "esma_row": r["_row"],
        "filer": r.get("ae_lei_name") or None,
        "filer_lei": r.get("ae_lei") or None,
        "person_seeking_admission": r.get("ae_lei_name_casp") or None,
        "person_seeking_admission_lei": r.get("ae_lei_casp") or None,
        "competent_authority": r.get("ae_competentAuthority") or None,
        "home_member_state": r.get("ae_homeMemberState") or None,
        "register_last_update": iso_date(r.get("wp_lastupdate")) or (r.get("wp_lastupdate") or None),
        "url": r.get("wp_url") or None,
        "comments": r.get("wp_comments") or None,
        "dti": parse_dtis(r.get("ae_DTI")),
        "ffg_dti": parse_dtis(r.get("ae_DTI_FFG")),
    }


def rule_matches(rule: dict, r: dict) -> bool:
    ok = True
    if "url" in rule:
        ok &= rule["url"].lower() in (r.get("wp_url") or "").lower()
    if "filer" in rule:
        ok &= rule["filer"].strip() == (r.get("ae_lei_name") or "").strip()
    return ok


def stage_mica(networks: list[dict], manifest: dict) -> tuple[dict, dict]:
    other = read_register("OTHER")
    known_dtis: dict[str, set] = {}
    results = {}
    seen_rows: set[int] = set()
    problems = []
    for n in networks:
        rx = re.compile(n["search"], re.I)
        accepted, rejected, unreviewed = [], [], []
        for r in other:
            hay = " ".join([r.get("wp_url", ""), r.get("wp_comments", ""), r.get("ae_lei_name", ""), r.get("ae_lei_name_casp", "")])
            if not rx.search(hay):
                continue
            acc = next((a for a in n.get("accept", []) if rule_matches(a, r)), None)
            rej = next((a for a in n.get("reject", []) if rule_matches(a, r)), None)
            s = row_summary(r)
            if acc and not rej:
                s["matched_by"] = {k: v for k, v in acc.items() if k in ("url", "filer")}
                if acc.get("note"):
                    s["note"] = acc["note"]
                accepted.append(s)
                seen_rows.add(r["_row"])
            elif rej:
                s["reason"] = rej["reason"]
                rejected.append(s)
            else:
                unreviewed.append(s)
        # DTI check of every accepted row
        ffg = n.get("ffg_dti")
        for s in accepted:
            if not ffg:
                s["dti_check"] = {"result": "not-checked", "why": "no FFG DTI known for this token in the register"}
            elif ffg in s["ffg_dti"] or ffg in s["dti"]:
                s["dti_check"] = {"result": "match", "expected_ffg_dti": ffg}
            elif not s["ffg_dti"] and not s["dti"]:
                s["dti_check"] = {"result": "row-has-no-dti", "expected_ffg_dti": ffg}
            else:
                s["dti_check"] = {"result": "MISMATCH", "expected_ffg_dti": ffg}
                problems.append(f"{n['id']}: accepted row {s['esma_row']} has DTI mismatch")
            known_dtis.setdefault(n["id"], set()).update(s["dti"] + s["ffg_dti"])
        if unreviewed:
            problems.append(f"{n['id']}: {len(unreviewed)} unreviewed candidate(s): " +
                            "; ".join(f"row {u['esma_row']} {u['filer']} {u['url']}" for u in unreviewed))
        results[n["id"]] = {"accepted": accepted, "rejected": rejected, "unreviewed": unreviewed}

    # DTI collision scan: rows outside a network's accepted set that carry one of its DTIs.
    for n in networks:
        dset = known_dtis.get(n["id"], set())
        if not dset:
            continue
        for r in other:
            if r["_row"] in {a["esma_row"] for a in results[n["id"]]["accepted"]}:
                continue
            hit = dset & set(parse_dtis(r.get("ae_DTI")) + parse_dtis(r.get("ae_DTI_FFG")))
            if not hit:
                continue
            if any(x["esma_row"] == r["_row"] for x in results[n["id"]]["rejected"]):
                continue
            rule = next((a for a in n.get("dti_collision_reject", []) if rule_matches(a, r)), None)
            s = row_summary(r)
            s["shared_dti"] = sorted(hit)
            if rule:
                s["reason"] = rule["reason"]
                results[n["id"]]["rejected"].append(s)
            else:
                results[n["id"]]["unreviewed"].append(s)
                problems.append(f"{n['id']}: unreviewed DTI collision row {s['esma_row']} {s['filer']}")
    return results, {"problems": problems}


def load_documents(networks, mica_rows) -> dict:
    """Resolve, download and parse every white paper of every accepted row."""
    docs_by_net = {}
    for n in networks:
        seen = {}
        for s in mica_rows[n["id"]]["accepted"]:
            url = normalise_url(s["url"])
            if not url:
                s["document_status"] = "no URL in register"
                continue
            docs, problem = resolve_documents(url)
            s["document_status"] = problem or "resolved"
            s["documents"] = []
            for d in docs:
                if d["kind"] == "error":
                    s["documents"].append({"url": d["url"], "status": "fetch failed: " + d["error"]})
                    continue
                key = d["url"]
                if key not in seen:
                    seen[key] = {"url": d["url"], "final_url": d.get("final_url"), "kind": d["kind"],
                                 "via": d["via"], "sha256": sha256_bytes(d["body"]), "bytes": len(d["body"]),
                                 "register_rows": [], "_body": d["body"]}
                seen[key]["register_rows"].append(s["esma_row"])
                s["documents"].append({"url": d["url"], "sha256": seen[key]["sha256"], "kind": d["kind"]})
        docs_by_net[n["id"]] = list(seen.values())
    return docs_by_net


def doc_date(url: str) -> str | None:
    m = re.search(r"(20\d{2})[-_](\d{2})[-_](\d{2})", url)
    return "-".join(m.groups()) if m else None


def stage_energy(networks, mica_rows, docs_by_net, policy) -> dict:
    thr = policy["energy"]
    filers = {}
    for n in networks:
        for s in mica_rows[n["id"]]["accepted"]:
            filers[s["esma_row"]] = s["person_seeking_admission"] if not s["filer"] or s["filer"] == "Not Available" else s["filer"]
    per_net = {}
    all_docs = []
    for n in networks:
        out_docs = []
        for d in docs_by_net.get(n["id"], []):
            body = d.pop("_body")
            rec = {k: v for k, v in d.items()}
            rec["filer"] = sorted({filers.get(r) for r in d["register_rows"] if filers.get(r)})
            if d["kind"] == "pdf":
                pages = pdf_pages(body)
                rec["pages"] = len(pages)
                ex = extract_pdf(pages)
            elif d["kind"] == "ixbrl":
                ex = extract_ixbrl(body)
            elif d["kind"] == "xhtml-table":
                ex = extract_table(body)
            else:
                rec["status"] = f"unsupported document kind {d['kind']}"
                out_docs.append(rec)
                continue
            rec["document_date"] = doc_date(d["url"])
            rec["part_j_labels_found"] = ex["labels_found"]
            rec["layout"] = ex["orientation"]
            rec["indicators"] = normalise_values(ex, d["kind"])
            rec["paper_dti"] = ex["dtis"]
            if ex.get("ixbrl_header"):
                rec["ixbrl_header"] = ex["ixbrl_header"]
            rec["s3_name_excerpt"] = ex["s3_text"][:120] or None
            # S.9 network list (template-error check)
            m = re.search(r"network\(s\)\s+(.+?)\s+is\s+calculated", ex["s9_text"], re.I)
            if m:
                nets = [x.strip(" .") for x in re.split(r",|\band\b", m.group(1)) if x.strip(" .")]
                rec["s9_networks"] = nets
            rec["intensity_basis"] = ("marginal: S.16 says the intensity is the marginal emission of one additional transaction"
                                      if re.search(r"marginal", ex["s16_text"], re.I) else
                                      ("average (S.16 does not say 'marginal')" if ex["s16_text"] else "not stated"))
            rec["flags"] = []
            if "s9_networks" in rec and not any(any(k in x.lower() for k in n["keywords"]) for x in rec["s9_networks"]):
                rec["flags"].append({"code": "TEMPLATE_ERROR",
                                     "detail": f"S.9 says the energy of network(s) {', '.join(rec['s9_networks'])} is calculated first - not {n['name']}"})
            ind = rec["indicators"]
            try:
                p0 = datetime.strptime(ind["S.6"]["value"], "%Y-%m-%d")
                p1 = datetime.strptime(ind["S.7"]["value"], "%Y-%m-%d")
                days = (p1 - p0).days
                rec["disclosure_period_days"] = days
                if not 360 <= days <= 370:
                    rec["flags"].append({"code": "DISCLOSURE_PERIOD_NOT_ONE_YEAR",
                                         "detail": f"S.6 {ind['S.6']['value']} to S.7 {ind['S.7']['value']} is {days} days; MiCA asks for a 12-month period (warning only)"})
            except (TypeError, KeyError, ValueError):
                pass
            if not ind.get("S.8") or ind["S.8"].get("value") is None:
                rec["flags"].append({"code": "NO_S8", "detail": "Energy consumption (S.8) not found or not a number with a printed unit" + (f": {ind['S.8']['raw']!r}" if ind.get("S.8") else "")})
            missing = [f for f in ("S.10", "S.11", "S.12", "S.13", "S.14") if not ind.get(f)]
            if missing and ind.get("S.8") and ind["S.8"].get("value") is not None:
                rec["flags"].append({"code": "SUPPLEMENTARY_INDICATORS_ABSENT",
                                     "detail": f"{', '.join(missing)} not disclosed; the paper gives the mandatory energy indicator only"})
            # implied grid intensity
            try:
                s8 = Decimal(ind["S.8"]["value"])
                ghg = Decimal(ind["S.12"]["value"]) + Decimal(ind["S.13"]["value"])
                if s8 > 0:
                    g = (ghg * 1000 / s8).quantize(Decimal("0.001"))
                    rec["implied_grid_intensity_kgco2e_per_kwh"] = str(g)
                    if g > Decimal(str(thr["implausible_grid_intensity_kg_per_kwh"])):
                        rec["flags"].append({"code": "IMPLAUSIBLE_GRID_INTENSITY",
                                             "detail": f"(S.12+S.13)/S.8 = {g} kgCO2e/kWh, above any national grid average"})
            except (TypeError, KeyError, InvalidOperation):
                pass
            rec["network"] = n["id"]
            out_docs.append(rec)
            all_docs.append(rec)
        per_net[n["id"]] = out_docs

    # Same S.13 figure printed for two different networks by the same filer: copy-paste.
    by_s13 = {}
    for rec in all_docs:
        v = (rec.get("indicators") or {}).get("S.13")
        if v and v.get("value") and Decimal(v["value"]) > 0:
            by_s13.setdefault(v["value"], []).append(rec)
    for val, recs in by_s13.items():
        nets = {r["network"] for r in recs}
        if len(nets) > 1:
            for r in recs:
                others = sorted(nets - {r["network"]})
                r["flags"].append({"code": "DUPLICATE_FIGURES",
                                   "detail": f"S.13 = {val} tCO2e is printed identically in a paper for {', '.join(others)}"})

    # PDF/xhtml twins (same publication): cross-check.
    for n in networks:
        docs = per_net[n["id"]]
        stems = {}
        for d in docs:
            stem = re.sub(r"\.(pdf|xhtml)$", "", d["url"].split("/")[-1], flags=re.I)
            stems.setdefault(stem, []).append(d)
        for stem, twins in stems.items():
            pdf = next((d for d in twins if d["kind"] == "pdf"), None)
            ix = next((d for d in twins if d["kind"] == "ixbrl"), None)
            if not (pdf and ix):
                continue
            agree = {}
            for f in FIELDS:
                a, b = (pdf["indicators"] or {}).get(f), (ix["indicators"] or {}).get(f)
                if not a or not b or a.get("value") is None or b.get("value") is None:
                    agree[f] = "n/a"
                    continue
                if f in ("S.6", "S.7"):
                    agree[f] = "equal" if a["value"] == b["value"] else "DIFFERENT"
                    continue
                da, db = Decimal(a["value"]), Decimal(b["value"])
                q = Decimal(1).scaleb(-(b.get("printed_decimals") or max(0, -db.as_tuple().exponent)))
                if f == "S.14":  # iXBRL S.14 is in tonnes with 5 decimals = 0.01 kg resolution
                    q = Decimal("0.01")
                agree[f] = "equal" if da == db else ("equal within iXBRL rounding" if abs(da - db) <= q else "DIFFERENT")
            pdf["xhtml_twin"] = {"url": ix["url"], "sha256": ix["sha256"], "agreement": agree}
            ix["pdf_twin"] = pdf["url"]
            if "DIFFERENT" in agree.values():
                pdf["flags"].append({"code": "PDF_XHTML_DISAGREE", "detail": json.dumps(agree)})

    # Per-network certified-figure candidate.
    networks_out = []
    for n in networks:
        docs = per_net[n["id"]]
        cands = []
        for d in docs:
            if d.get("kind") != "pdf" and d.get("pdf_twin"):
                continue  # use the PDF of a twin pair (more decimals, page numbers)
            s14 = (d.get("indicators") or {}).get("S.14")
            blocking = [f["code"] for f in d.get("flags", []) if f["code"] in ("TEMPLATE_ERROR", "DUPLICATE_FIGURES", "IMPLAUSIBLE_GRID_INTENSITY", "PDF_XHTML_DISAGREE")]
            if not s14 or s14.get("value") is None:
                continue
            kg = Decimal(s14["value"])
            warnings = [f"{f['code']}: {f['detail']}" for f in d.get("flags", []) if f["code"] not in blocking]
            c = {"document": d["url"], "sha256": d["sha256"], "filer": d["filer"], "kg": kg, "s14": s14, "warnings": warnings,
                 "period_end": ((d["indicators"].get("S.7") or {}).get("value")), "date": d.get("document_date") or "", "blocking": blocking}
            cands.append(c)
        usable = [c for c in cands if c["kg"] > 0 and not c["blocking"]]
        usable.sort(key=lambda c: (c["period_end"] or "", c["date"]), reverse=True)
        sel = None
        reason = None
        if usable:
            c = usable[0]
            dec = c["s14"]["printed_decimals"]
            per_unit_kg = {"kgCO2e": Decimal(1), "gCO2e": Decimal("0.001"), "tCO2e": Decimal(1000)}[c["s14"]["printed_unit"]]
            half = Decimal(1).scaleb(-dec) * per_unit_kg / 2
            ug = int(c["kg"] * Decimal(10) ** 9)
            half_ug = int(half * Decimal(10) ** 9)
            rel = (half / c["kg"]) if c["kg"] else None
            sel = {"ugco2e_per_tx": ug, "kgco2e_per_tx": str(c["kg"]), "source_field": "S.14 GHG intensity",
                   "document": c["document"], "document_sha256": c["sha256"], "filer": c["filer"],
                   "page": c["s14"].get("page"), "ixbrl_fact": c["s14"].get("ixbrl_fact"), "raw": c["s14"]["raw"],
                   "disclosure_period_end": c["period_end"],
                   "document_warnings": c["warnings"],
                   "intensity_basis": next(x.get("intensity_basis") for x in docs if x["url"] == c["document"]),
                   "rounding_interval_ugco2e": [ug - half_ug, ug + half_ug],
                   "relative_half_interval": str(rel.quantize(Decimal("0.0001"))) if rel is not None else None}
            if rel is not None and rel >= Decimal(str(thr["max_low_precision_relative_half_interval"])):
                sel["precision_warning"] = (f"printed to {dec} decimals: the true value lies anywhere in "
                                            f"[{ug - half_ug}, {ug + half_ug}] ugCO2e")
        else:
            if not docs:
                reason = "no white-paper document could be retrieved from the register URL"
            elif not cands:
                reason = "no retrieved paper discloses S.14 GHG intensity"
            elif all(c["kg"] == 0 for c in cands if not c["blocking"]) and any(not c["blocking"] for c in cands):
                reason = "S.14 is printed as zero at the paper's precision (e.g. 0.00000 kgCO2e); a zero cannot be certified (registry requires emissionsUg > 0) and the true value is unknown"
            else:
                reason = "every paper that discloses S.14 carries a blocking data-quality flag: " + "; ".join(
                    f"{c['document'].split('/')[-1]}: {','.join(c['blocking']) or 'zero'}" for c in cands)
        networks_out.append({
            "network": n["id"], "name": n["name"], "token": n["token"], "caip2": n["caip2"],
            "has_mica_white_paper": bool(mica_rows[n["id"]]["accepted"]),
            "documents": [{k: v for k, v in d.items() if k != "network"} for d in docs],
            "certifiable_figure": sel,
            "null_reason": reason if sel is None and mica_rows[n["id"]]["accepted"] else (None if sel else "no MiCA white paper in ESMA's register"),
        })
    return {"networks": networks_out}


def stage_emt(manifest) -> dict:
    emt = read_register("EMTWP")
    art = read_register("ARTZZ")
    casps = read_register("CASPS")
    ncasp = read_register("NCASP")
    token_rx = re.compile(r"\b(EURAU|CHFAU|SEKAU|USDAU|EUROe|eUSD|USDG|EURC|USDC|EURCV|USDCV|EUROP|EUROD|EURe|EURW|EURR|"
                          r"ENEUR|ENGBP|ENUSD|EURQ|USDQ|EURD|PLNQ|GBPQ|RONQ|WEUR|EUB|USB|EURGH|EURI)\b", re.I)
    canon = {t.lower(): t for t in ["EURAU", "CHFAU", "SEKAU", "USDAU", "EUROe", "eUSD", "USDG", "EURC", "USDC", "EURCV", "USDCV",
                                     "EUROP", "EUROD", "EURe", "EURW", "EURR", "ENEUR", "ENGBP", "ENUSD", "EURQ", "USDQ", "EURD",
                                     "PLNQ", "GBPQ", "RONQ", "WEUR", "EUB", "USB", "EURGH", "EURI"]}

    def token_hint(r):
        for field in ("wp_comments", "wp_url"):
            text = re.sub(r"[-_/]", " ", r.get(field, ""))
            m = token_rx.search(text)
            if m:
                return canon[m.group(1).lower()], field
        return None, None

    issuers = {}
    for r in emt:
        key = r.get("ae_lei") or r.get("ae_lei_name")
        i = issuers.setdefault(key, {"issuer": r.get("ae_lei_name"), "lei": r.get("ae_lei") or None,
                                     "commercial_name": r.get("ae_commercial_name") or None,
                                     "home_member_state": r.get("ae_homeMemberState"),
                                     "competent_authority": r.get("ae_competentAuthority"),
                                     "authorisation": r.get("ae_authorisation_other_emt") or None,
                                     "authorisation_date": iso_date(r.get("ac_authorisationNotificationDate")),
                                     "authorisation_end": iso_date(r.get("ac_authorisationEndDate")) or None,
                                     "white_papers": []})
        tok, src = token_hint(r)
        i["white_papers"].append({
            "esma_row": r["_row"], "token_hint": tok, "token_hint_source": src,
            "url": r.get("wp_url") or None, "notified": iso_date(r.get("wp_authorisationNotificationDate")),
            "dti": parse_dtis(r.get("ae_DTI")), "ffg_dti": parse_dtis(r.get("ae_DTI_FFG")),
            "limited_network_exemption_48_4": r.get("ae_exemption48_4") or None,
            "exemption_48_5": r.get("ae_exemption48_5") or None,
            "comments": r.get("wp_comments") or None})
    tether = bool(re.search(r"tether|usdt", " ".join(str(v) for r in emt + art for v in r.values()), re.I))
    return {
        "emt_issuers": sorted(issuers.values(), key=lambda x: (x["home_member_state"] or "", x["issuer"] or "")),
        "emt_white_paper_rows": len(emt),
        "art_issuers": [row_summary(r) | {"issuer": r.get("ae_lei_name")} for r in art],
        "art_rows": len(art),
        "tether_usdt_in_emt_or_art_register": tether,
        "casp_rows": len(casps),
        "casp_distinct_lei": len({r.get("ae_lei") for r in casps if r.get("ae_lei")}),
        "non_compliant_entities_rows": len(ncasp),
    }


RMG_URL = "https://web.archive.org/web/20260316023419id_/https://www.iso20022.org/registration-management-group-member-list"


def stage_iso(networks, mica_rows, iso_cfg) -> dict:
    ISO_DIR.mkdir(parents=True, exist_ok=True)
    snap_p = ISO_DIR / "rmg-members.json"
    try:
        body, _ = fetch(RMG_URL)
        t = body.decode("utf-8", "ignore")
        t = re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S)
        lines = [l.strip() for l in html.unescape(re.sub(r"<[^>]+>", "\n", t)).split("\n") if l.strip()]
        a = lines.index("Member entity") + 2 if "Member entity" in lines else None
        b = next(i for i, l in enumerate(lines) if l.startswith("©"))
        pairs = [{"member_entity": lines[i], "company": lines[i + 1]} for i in range(a, b - 1, 2)] if a else []
        head = next((l for l in lines if l.startswith("The RMG has")), None)
        snap = {"source": RMG_URL, "snapshot": iso_cfg["rmg_source"]["snapshot_date"], "html_sha256": sha256_bytes(body),
                "header": head, "member_company_pairs": pairs,
                "parse_note": "Pairs read in page order from the 'RMG member list' table (Member entity, Company)."}
        write_json(snap_p, snap)
    except Exception as e:  # noqa: BLE001
        if not snap_p.exists():
            raise SystemExit(f"cannot build RMG snapshot: {e}")
        snap = load_json(snap_p)
    haystack = [(p["member_entity"] + " | " + p["company"]) for p in snap["member_company_pairs"]]
    netmap = {n["id"]: n for n in networks}
    out = []
    for e in iso_cfg["launch_list"]:
        n = netmap[e["network"]]
        hits = [h for h in haystack if any(re.search(r"\b" + re.escape(k) + r"\b", h, re.I) for k in e["rmg_names"])]
        out.append({
            "network": n["id"], "name": n["name"], "caip2": n["caip2"],
            "status": "provisional",
            "evidence_level": e["level"],
            "rmg_matches": hits,
            "evidence": e["evidence"],
            **({"caveat": e["caveat"]} if e.get("caveat") else {}),
            **({"route_to_full": e["route_to_full"]} if e.get("route_to_full") else {}),
            "criteria": {
                "1_technical": "NOT MET - no CLPR Router with ISO 20022 payload handling deployed on this network; conformance suite not yet run",
                "2_standards": ("MET (standards body)" if e["level"] == "standards-body" else f"PROVISIONAL only ({e['level']}): no TC 68 participation, RA-registered message definitions or ISO/IEC 27001 evidence recorded"),
                "3_data_handling": "NOT YET DEMONSTRATED - enforced by the Router, which is not deployed",
                "4_identified_operator": "NOT MET - no Router operator chosen",
            },
            "mica_white_paper": bool(mica_rows[n["id"]]["accepted"]),
            "certification_ready": False,
        })
    return {"checked": iso_cfg["checked"], "rmg_source": iso_cfg["rmg_source"],
            "rmg_blockchain_finding": "Of the launch-list networks, only Ripple (member entity 'RippleNet') appears on the RMG list.",
            "launch_list": out, "not_listed": iso_cfg["not_listed"],
            "summary": "No launch-list network meets all four registry criteria today, so no ISO 20022 certification decision is drafted."}


def cast(*args) -> str:
    return run(["cast", *args])


def stage_decisions(networks, mica_rows, energy, policy, manifest) -> list[dict]:
    for p in (ROOT / "decisions").glob("*.json"):
        p.unlink()
    for p in (ROOT / "evidence").glob("*.json"):
        p.unlink()
    domain = cast("keccak", policy["registry_domain"])
    en_by = {e["network"]: e for e in energy["networks"]}
    nonce = policy["first_nonce"]
    made = []
    for n in networks:
        rows = mica_rows[n["id"]]["accepted"]
        e = en_by[n["id"]]
        # Criterion 2 = we opened a paper whose Part J prints an energy-consumption figure (S.8). Unit parsing is
        # not required here (Bitstamp's rendered tables print bare numbers), but the figure must be numeric.
        papers_with_part_j = [d for d in e["documents"] if (d.get("indicators") or {}).get("S.8")
                              and (d["indicators"]["S.8"].get("value") is not None
                                   or re.fullmatch(r"[\d.,]+", (d["indicators"]["S.8"].get("raw") or "").replace(" ", "")))]
        drafts = []
        if rows and papers_with_part_j:
            drafts.append(("MICA", {
                "label": "MICA", "network": n["id"], "caip2": n["caip2"],
                "criteria": {
                    "1_registered_white_paper": {"met": True, "esma_rows": [
                        {k: r[k] for k in ("esma_row", "filer", "person_seeking_admission", "competent_authority", "register_last_update", "url", "dti_check")}
                        for r in rows]},
                    "2_sustainability_disclosure": {"met": True, "papers": [
                        {"url": d["url"], "sha256": d["sha256"], "part_j_labels_found": d["part_j_labels_found"],
                         "flags": [f["code"] for f in d["flags"]]} for d in papers_with_part_j]},
                    "3_authorised_operator": {"met": None, "note": "Operator-level: checked when Router operators are chosen (spec 'Still to check')."},
                    "4_allowed_assets": {"met": None, "note": "Enforced by the Router at the origin against the EMT/ART list in mica.json."},
                    "5_transfer_data": {"met": None, "note": "Enforced by the Router (encrypted originator/beneficiary data)."},
                },
                "register_snapshot": {k: v["sha256"] for k, v in manifest["files"].items() if k in ("OTHER", "CASPS", "EMTWP", "ARTZZ")},
            }, 0, ""))
        sel = e["certifiable_figure"]
        if sel:
            src = (f"MiCA WP S.14 {sel['kgco2e_per_tx']} kgCO2e/tx; {', '.join(sel['filer'])}; period to {sel['disclosure_period_end']}; "
                   f"sha256:{sel['document_sha256'][:16]}")
            drafts.append(("ENERGY", {
                "label": "ENERGY", "network": n["id"], "caip2": n["caip2"],
                "figure": sel,
                "all_documents": [{"url": d["url"], "sha256": d["sha256"],
                                   "S.14": (d.get("indicators") or {}).get("S.14"),
                                   "flags": [f["code"] for f in d.get("flags", [])]} for d in e["documents"]],
                "method_note": "Figure is the white paper's own S.14 GHG intensity, converted kg -> ug (x 1e9). Not recomputed.",
            }, sel["ugco2e_per_tx"], src))
        for label, record, ug, src in drafts:
            ev = {"schema": "clprouter.evidence.v1", "prepared": "2026-10-01", **record}
            ev_bytes = canonical(ev)
            ev_hash = "0x" + sha256_bytes(ev_bytes)
            ev_name = f"{n['id']}.{label.lower()}.json"
            (ROOT / "evidence").mkdir(exist_ok=True)
            (ROOT / "evidence" / ev_name).write_bytes(ev_bytes + b"\n")
            lab = policy["labels"][label]
            payload = cast("abi-encode", "f(string,uint8,uint64,uint64,string)", n["caip2"], str(lab), str(policy["expiry"]), str(ug), src)
            payload_hash = cast("keccak", payload)
            enc = cast("abi-encode", "f(bytes32,uint8,bytes32,bytes32,uint64,uint64,uint64,uint64)", domain,
                       str(policy["action_certify"]), payload_hash, ev_hash, str(nonce), str(policy["effective_at"]),
                       str(policy["valid_until"]), str(policy["epoch"]))
            digest = cast("keccak", enc)
            to_sign = cast("keccak", "0x" + b"\x19Ethereum Signed Message:\n32".hex() + digest[2:])
            dec = {
                "status": "DRAFT - unsigned; for provider-committee review",
                "network": n["id"], "name": n["name"], "label": label,
                "decision": {"action": policy["action_certify"], "payload": payload, "evidenceHash": ev_hash, "nonce": nonce,
                             "effectiveAt": policy["effective_at"], "validUntil": policy["valid_until"], "epoch": policy["epoch"]},
                "payload_decoded": {"ledgerId": n["caip2"], "label": lab, "expiry": policy["expiry"], "emissionsUg": ug,
                                    "emissionsSource": src},
                "payload_abi": "(string ledgerId, uint8 label, uint64 expiry, uint64 emissionsUg, string emissionsSource)",
                "evidence_record": f"evidence/{ev_name}",
                "evidence_hash_rule": "sha256 over the exact bytes of the evidence file minus its trailing newline (canonical JSON: sorted keys, no spaces, UTF-8)",
                "digest": digest,
                "eip191_hash_to_sign": to_sign,
                "signatures": [],
                "notes": [policy["nonce_note"], policy["expiry_note"], policy["effective_at_note"]]
                         + ([f"caip2: {n['caip2_source']}"] if "confirm" in n["caip2_source"] else [])
                         + ([sel["precision_warning"]] if label == "ENERGY" and sel.get("precision_warning") else [])
                         + (sel["document_warnings"] if label == "ENERGY" else [])
                         + (["Intensity basis - " + sel["intensity_basis"] + "; the spec's Greenest mode assumes an allocation (total / transactions)"]
                            if label == "ENERGY" and sel["intensity_basis"].startswith("marginal") else []),
            }
            fname = f"{nonce:03d}-{n['id']}-{label.lower()}.json"
            write_json(ROOT / "decisions" / fname, dec)
            made.append({"file": fname, "network": n["id"], "label": label, "nonce": nonce})
            nonce += 1
    return made


def main() -> None:
    global OFFLINE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh-esma", action="store_true")
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()
    OFFLINE = a.offline
    cfg = load_json(ROOT / "config" / "networks.json")
    policy = load_json(ROOT / "config" / "policy.json")
    iso_cfg = load_json(ROOT / "config" / "iso20022.json")
    networks = cfg["networks"]

    manifest = esma_refresh(a.refresh_esma)
    mica_rows, mica_meta = stage_mica(networks, manifest)
    if mica_meta["problems"]:
        print("REVIEW NEEDED:\n  " + "\n  ".join(mica_meta["problems"]), file=sys.stderr)
        sys.exit(2)
    docs_by_net = load_documents(networks, mica_rows)
    energy = stage_energy(networks, mica_rows, docs_by_net, policy)

    # Paper-level DTI check back into mica.json: the DTIs printed in each paper (Part F) against the token's
    # FFG DTI and every DTI the accepted register rows carry.
    en_by = {e["network"]: e for e in energy["networks"]}
    paper_dti_summary = {}
    for n in networks:
        ffg = n.get("ffg_dti")
        known = set()
        for s in mica_rows[n["id"]]["accepted"]:
            known |= set(s["dti"]) | set(s["ffg_dti"])
        printed = {}
        for s in mica_rows[n["id"]]["accepted"]:
            for d in s.get("documents", []):
                full = next((x for x in en_by[n["id"]]["documents"] if x["url"] == d["url"]), None)
                if not full or "paper_dti" not in full:
                    continue
                pd = full["paper_dti"]
                d["paper_dti"] = pd
                codes = set(pd["dti"]) | set(pd["ffg"])
                printed[d["url"]] = sorted(codes)
                if not codes:
                    d["paper_dti_check"] = "paper prints no DTI"
                elif ffg and ffg in pd["ffg"]:
                    d["paper_dti_check"] = "match: paper's FFG DTI field = token FFG DTI"
                elif ffg and ffg in pd["dti"]:
                    d["paper_dti_check"] = "match, but the paper prints the FFG DTI in its DTI field"
                elif known and codes & known:
                    d["paper_dti_check"] = "match: paper DTI is one of the token's register DTIs"
                elif known:
                    d["paper_dti_check"] = "MISMATCH: paper DTI not among the token's register DTIs"
                else:
                    d["paper_dti_check"] = "unverified: no DTI for this token in the register to compare with"
        distinct = sorted({c for v in printed.values() for c in v})
        summary = {"register_dtis": sorted(known), "dtis_printed_in_papers": distinct}
        if not known and len({tuple(v) for v in printed.values() if v}) > 1:
            summary["conflict"] = ("papers print different DTIs and the register carries none, so which is the native "
                                   "token's DTI cannot be settled without the DTI Foundation registry: " +
                                   "; ".join(f"{u.split('/')[-1][:60]}: {','.join(v)}" for u, v in printed.items() if v))
        paper_dti_summary[n["id"]] = summary

    emt = stage_emt(manifest)
    mica_out = {
        "schema": "clprouter.mica.v1",
        "register": {"name": "ESMA interim MiCA register", "files": manifest["files"]},
        "method": "Candidates = rows of OTHER.csv whose URL, comments or filer names match the network's search regex "
                  "(config/networks.json). Each candidate is accepted or rejected by an explicit rule; rows sharing a DTI with "
                  "an accepted row are listed too. Accepted rows are checked against the token's FFG DTI, and the DTI printed "
                  "in the white paper itself where the paper could be retrieved.",
        "networks": [],
        "stablecoins": emt,
    }
    for n in networks:
        r = mica_rows[n["id"]]
        mica_out["networks"].append({
            "network": n["id"], "name": n["name"], "token": n["token"], "caip2": n["caip2"],
            "caip2_source": n["caip2_source"], "ffg_dti": n.get("ffg_dti"),
            "dti_summary": paper_dti_summary[n["id"]],
            "white_paper_in_register": bool(r["accepted"]),
            "filers": sorted({(x["filer"] if x["filer"] and x["filer"] != "Not Available" else x["person_seeking_admission"]) or "?" for x in r["accepted"]}),
            "white_papers": r["accepted"],
            "rejected_false_positives": r["rejected"],
        })
    write_json(ROOT / "mica.json", mica_out)
    write_json(ROOT / "energy.json", {"schema": "clprouter.energy.v1",
                                      "units": {"ugco2e_per_tx": "micrograms CO2e per transaction (integer) = S.14 kgCO2e x 1e9",
                                                "S.8": "kWh per year", "S.10": "percent", "S.11": "kWh per transaction",
                                                "S.12/S.13": "tCO2e per year", "S.14": "kgCO2e per transaction"},
                                      "field_names": FIELD_NAMES,
                                      **energy})
    iso = stage_iso(networks, mica_rows, iso_cfg)
    write_json(ROOT / "iso20022.json", iso)
    made = stage_decisions(networks, mica_rows, energy, policy, manifest)
    print(json.dumps({"decisions": made}, indent=1))


if __name__ == "__main__":
    main()
