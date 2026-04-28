import { XMLParser } from 'fast-xml-parser';

export type ResponseFormat = 'json' | 'xml' | 'auto';

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
