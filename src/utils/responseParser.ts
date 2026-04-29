import { brotliDecompress, gunzip, inflate, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';

export type ResponseFormat = 'json' | 'xml' | 'auto';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const brotliAsync = promisify(brotliDecompress);

// gzip RFC 1952 magic.
function isGzip(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// zlib RFC 1950 header. CMF byte = 0x78 (deflate, 32K window) is the only
// realistic value for HTTP. FLG check byte combos rotate by compression
// level: 0x01 (low), 0x5e, 0x9c (default), 0xda (best). Matching just the
// CMF would over-trigger on plain text starting with 'x'; pairing it with
// a known FLG keeps the false-positive rate ~zero.
function isZlib(buf: Uint8Array): boolean {
  if (buf.length < 2 || buf[0] !== 0x78) return false;
  return buf[1] === 0x01 || buf[1] === 0x5e || buf[1] === 0x9c || buf[1] === 0xda;
}

// Decompresses if Content-Encoding (or magic bytes) say so. Supports gzip,
// deflate (zlib + raw fallback), and brotli. Returns plain bytes otherwise.
//
// undici fetch usually decompresses transparently (and strips the header)
// — this layer exists for misbehaving upstreams (e.g. some Kelkoo
// endpoints) that emit gzipped bodies without a Content-Encoding header.
export async function decompressBody(
  bytes: Uint8Array,
  encoding?: string | null,
): Promise<Buffer> {
  const enc = encoding?.toLowerCase().trim() ?? '';
  if (enc === 'gzip' || enc === 'x-gzip') return Buffer.from(await gunzipAsync(bytes));
  if (enc === 'deflate') {
    // HTTP "deflate" can be either zlib-wrapped (RFC 1950) or raw deflate
    // (RFC 1951). Try zlib first, then raw — many older servers send raw.
    try { return Buffer.from(await inflateAsync(bytes)); }
    catch { return Buffer.from(await inflateRawAsync(bytes)); }
  }
  if (enc === 'br') return Buffer.from(await brotliAsync(bytes));
  // No header / "identity" — sniff for gzipped bodies missing the header.
  if (isGzip(bytes)) return Buffer.from(await gunzipAsync(bytes));
  if (isZlib(bytes)) return Buffer.from(await inflateAsync(bytes));
  return Buffer.from(bytes);
}

// Configured once and reused. The two non-default options matter for our
// mapping engine:
//   - alwaysCreateTextNode: "<id>123</id>" -> { "#text": "123" } (predictable shape)
//   - parseTagValue / parseAttributeValue: keep numbers as numbers so the
//     mapping's payout_path lands on a Number, not a String of a Number.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
  // Tag names that show up as siblings should always become arrays so
  // `items_path` lands on an array instead of a single object when the API
  // happens to return one record. Configurable per-call below.
  isArray: () => false,
});

interface ParseOptions {
  // Tag names that should be coerced to arrays even when only one element
  // is present. Driven by the configured `mapping.items_path` so a
  // single-record response still walks the loop. Names are matched on the
  // *leaf* segment of the path.
  arrayTags?: Set<string>;
}

function buildXmlParser(opts: ParseOptions): XMLParser {
  // Building per-call lets us thread arrayTags through without a global
  // cache. Construction is cheap (microbenchmarked: ~10µs).
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: true,
    parseAttributeValue: true,
    trimValues: true,
    isArray: opts.arrayTags
      ? (name) => opts.arrayTags!.has(name)
      : () => false,
  });
}

function leafSegment(path: string): string | undefined {
  if (!path) return undefined;
  // Split by dot or "[" — the leaf is the last simple identifier.
  const m = path.match(/([A-Za-z_][\w-]*)\s*(?:\[\d+\])?$/);
  return m?.[1];
}

function detectFormat(contentType: string, body: string): 'json' | 'xml' {
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  // Body sniff. JSON commonly starts with { or [; XML with <?xml or <.
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return 'xml';
  return 'json';
}

export interface ParseInput {
  body: string;
  contentType?: string;
  // Explicit format from the API config. 'auto' falls back to content-type
  // sniffing — useful for upstreams that respond with text/plain but emit
  // valid JSON or XML.
  format?: ResponseFormat;
  // Path the sync engine will iterate; used so single-record XML responses
  // still produce an array at items_path.
  itemsPath?: string;
}

// Returns the parsed body as a plain JS object/array. Throws on hard parse
// errors (caller surfaces as a run error). Empty body → empty object.
export function parseResponseBody(input: ParseInput): unknown {
  const body = input.body ?? '';
  if (body.trim() === '') return {};

  const format =
    input.format && input.format !== 'auto'
      ? input.format
      : detectFormat(input.contentType ?? '', body);

  if (format === 'json') {
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new Error(`json_parse_failed: ${(err as Error).message}`);
    }
  }

  // XML — coerce the items_path leaf to an array so single-record responses
  // are walked the same as multi-record ones.
  const arrayTags = new Set<string>();
  const leaf = leafSegment(input.itemsPath ?? '');
  if (leaf) arrayTags.add(leaf);
  try {
    const parser = arrayTags.size > 0 ? buildXmlParser({ arrayTags }) : xmlParser;
    return parser.parse(body);
  } catch (err) {
    throw new Error(`xml_parse_failed: ${(err as Error).message}`);
  }
}
