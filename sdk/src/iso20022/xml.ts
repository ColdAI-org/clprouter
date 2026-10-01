/**
 * XML layer over fast-xml-parser (maintained, dependency-light, no native code, no network). Builds ISO 20022
 * `Document` trees in schema element order and reads them back strictly:
 *
 * - DOCTYPE / ENTITY declarations are refused (no XXE, no entity expansion);
 * - the root must be `Document` in the expected `urn:iso:std:iso:20022:tech:xsd:*` namespace (default or prefixed);
 * - every element is checked against the set the reader expects, so unknown or misspelt elements fail;
 * - singular elements that repeat fail.
 */
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { IsoValidationError, Issues } from "./validate.js";

export type XmlValue = string | XmlObj | XmlValue[] | undefined;
export interface XmlObj {
  [k: string]: XmlValue;
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  htmlEntities: false,
});

/** Drop undefined values, empty objects and empty arrays so optional elements are omitted. */
function prune(v: XmlValue): XmlValue {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const a = v.map(prune).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  const o: XmlObj = {};
  for (const [k, x] of Object.entries(v)) {
    const p = prune(x);
    if (p !== undefined) o[k] = p;
  }
  return Object.keys(o).length ? o : undefined;
}

export function buildDocument(namespace: string, root: string, body: XmlObj): string {
  const tree = { Document: { "@_xmlns": namespace, [root]: prune(body) ?? "" } };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(tree)}`;
}

export interface ParsedDocument {
  namespace: string;
  root: string;
  body: XmlObj;
}

/** Remove the document's namespace prefix from every element name; reject foreign prefixes and stray xmlns. */
function unprefix(v: XmlValue, prefix: string, path: string, issues: Issues): XmlValue {
  if (v === undefined || typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => unprefix(x, prefix, path, issues));
  const o: XmlObj = {};
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith("@_xmlns")) continue;
    if (k.startsWith("@_") || k === "#text") {
      o[k] = x;
      continue;
    }
    let name = k;
    if (prefix) {
      if (!k.startsWith(`${prefix}:`)) {
        issues.add(path, `element <${k}> is outside the document namespace`);
        continue;
      }
      name = k.slice(prefix.length + 1);
    } else if (k.includes(":")) {
      issues.add(path, `element <${k}> is outside the document namespace`);
      continue;
    }
    o[name] = unprefix(x, prefix, `${path}/${name}`, issues);
  }
  return o;
}

/** Parse an ISO 20022 `Document`. Throws `IsoValidationError` on malformed or unsafe XML. */
export function parseDocument(xml: string): ParsedDocument {
  if (typeof xml !== "string") throw new IsoValidationError("XML", ["input must be a string"]);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new IsoValidationError("XML", ["DOCTYPE and ENTITY declarations are not allowed"]);
  const ok = XMLValidator.validate(xml);
  if (ok !== true) throw new IsoValidationError("XML", [`not well-formed: ${ok.err.msg} (line ${ok.err.line})`]);
  const tree = parser.parse(xml) as XmlObj;
  const docKeys = Object.keys(tree).filter((k) => /^(?:[A-Za-z_][\w.-]*:)?Document$/.test(k));
  const other = Object.keys(tree).filter((k) => !docKeys.includes(k) && k !== "#text");
  if (docKeys.length !== 1 || other.length > 0) throw new IsoValidationError("XML", ["root element must be a single <Document>"]);
  const docKey = docKeys[0]!;
  const prefix = docKey.includes(":") ? docKey.slice(0, docKey.indexOf(":")) : "";
  const doc = tree[docKey];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new IsoValidationError("XML", ["<Document> is empty"]);
  const nsAttr = prefix ? `@_xmlns:${prefix}` : "@_xmlns";
  const namespace = doc[nsAttr];
  if (typeof namespace !== "string" || !namespace.startsWith("urn:iso:std:iso:20022:tech:xsd:")) {
    throw new IsoValidationError("XML", ["<Document> is not in an ISO 20022 namespace"]);
  }
  const issues = new Issues();
  const body = unprefix(doc, prefix, "Document", issues) as XmlObj;
  const roots = Object.keys(body).filter((k) => !k.startsWith("@_"));
  if (roots.length !== 1) issues.add("Document", "must contain exactly one message element");
  issues.throwIfAny("XML");
  const root = roots[0]!;
  const content = body[root];
  return { namespace, root, body: content && typeof content === "object" && !Array.isArray(content) ? content : {} };
}

// ── Strict reader ───────────────────────────────────────────────────────────

/** A view on one element that records problems in a shared `Issues` list instead of throwing. */
export class Node {
  constructor(
    readonly o: XmlObj,
    readonly path: string,
    readonly issues: Issues,
  ) {}

  /** Fail on any child element (or attribute) not in `allowed`. */
  only(...allowed: string[]): this {
    for (const k of Object.keys(this.o)) {
      if (!allowed.includes(k)) this.issues.add(this.path, `unexpected ${k.startsWith("@_") ? "attribute" : "element"} <${k.replace(/^@_/, "")}>`);
    }
    return this;
  }

  private one(name: string): XmlValue {
    const v = this.o[name];
    if (Array.isArray(v)) {
      this.issues.add(`${this.path}/${name}`, "must not repeat");
      return v[0];
    }
    return v;
  }

  has(name: string): boolean {
    return this.o[name] !== undefined;
  }

  text(name: string): string | undefined {
    const v = this.one(name);
    if (v === undefined) return undefined;
    if (typeof v === "string") return v;
    this.issues.add(`${this.path}/${name}`, "must be a text element");
    return undefined;
  }

  child(name: string): Node | undefined {
    const v = this.one(name);
    if (v === undefined) return undefined;
    if (typeof v === "string" || Array.isArray(v)) {
      this.issues.add(`${this.path}/${name}`, "must be a structured element");
      return undefined;
    }
    return new Node(v, `${this.path}/${name}`, this.issues);
  }

  /** Repeated element as a list of nodes. */
  children(name: string): Node[] {
    const v = this.o[name];
    const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
    return list.flatMap((x, i) => {
      if (typeof x !== "object" || Array.isArray(x)) {
        this.issues.add(`${this.path}/${name}[${i}]`, "must be a structured element");
        return [];
      }
      return [new Node(x, `${this.path}/${name}[${i}]`, this.issues)];
    });
  }

  /** Repeated text element. */
  texts(name: string): string[] {
    const v = this.o[name];
    const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
    return list.flatMap((x, i) => {
      if (typeof x !== "string") {
        this.issues.add(`${this.path}/${name}[${i}]`, "must be a text element");
        return [];
      }
      return [x];
    });
  }

  /** `ActiveCurrencyAndAmount`. */
  amount(name: string): { value: string; currency: string } | undefined {
    const v = this.one(name);
    if (v === undefined) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) {
      this.issues.add(`${this.path}/${name}`, "needs a Ccy attribute");
      return undefined;
    }
    new Node(v, `${this.path}/${name}`, this.issues).only("#text", "@_Ccy");
    const value = v["#text"];
    const currency = v["@_Ccy"];
    if (typeof value !== "string" || typeof currency !== "string") {
      this.issues.add(`${this.path}/${name}`, "needs a value and a Ccy attribute");
      return undefined;
    }
    return { value, currency };
  }
}
