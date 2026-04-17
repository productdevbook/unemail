/**
 * Minimal DMARC aggregate (RUA) XML report parser. Zero-dep — we only
 * need the narrow RUA schema Google/Yahoo/Microsoft emit. Input can be
 * raw XML, gzipped bytes, or a fetch Response body.
 *
 * @module
 */

export interface DmarcReport {
  orgName?: string
  email?: string
  reportId?: string
  domain?: string
  dateRange?: { begin: Date; end: Date }
  policy?: {
    p?: "none" | "quarantine" | "reject"
    sp?: "none" | "quarantine" | "reject"
    adkim?: "r" | "s"
    aspf?: "r" | "s"
    pct?: number
  }
  records: ReadonlyArray<DmarcRecord>
}

export interface DmarcRecord {
  sourceIp?: string
  count: number
  disposition?: "none" | "quarantine" | "reject"
  dkim?: "pass" | "fail"
  spf?: "pass" | "fail"
  headerFrom?: string
}

/** Parse a DMARC aggregate report. Accepts a plain XML string or a
 *  gzipped Uint8Array (detected via magic bytes). */
export async function parseDmarcAggregate(input: string | Uint8Array): Promise<DmarcReport> {
  const xml = typeof input === "string" ? input : await gunzipOrUtf8(input)
  return parseReportXml(xml)
}

async function gunzipOrUtf8(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // Use DecompressionStream if available, else node:zlib.
    const g = globalThis as { DecompressionStream?: typeof DecompressionStream }
    if (g.DecompressionStream) {
      const stream = new Response(
        new Response(bytes as BufferSource).body!.pipeThrough(new g.DecompressionStream("gzip")),
      )
      return stream.text()
    }
    // Node.js fallback.
    const zlibModule = await import("node:zlib").catch(() => null)
    if (zlibModule) {
      return new Promise((resolve, reject) => {
        zlibModule.gunzip(Buffer.from(bytes), (err, out) => {
          if (err) reject(err)
          else resolve(out.toString("utf8"))
        })
      })
    }
    throw new Error("[unemail/dmarc] gzip input but no DecompressionStream / node:zlib available")
  }
  return new TextDecoder().decode(bytes)
}

function parseReportXml(xml: string): DmarcReport {
  const out: DmarcReport = { records: [] }
  const records: DmarcRecord[] = []

  out.orgName = takeTag(xml, "org_name")
  out.email = takeTag(xml, "email")
  out.reportId = takeTag(xml, "report_id")
  out.domain = takeTag(xml, "domain")

  const rangeBlock = takeSection(xml, "date_range")
  if (rangeBlock) {
    const begin = Number(takeTag(rangeBlock, "begin"))
    const end = Number(takeTag(rangeBlock, "end"))
    if (Number.isFinite(begin) && Number.isFinite(end))
      out.dateRange = { begin: new Date(begin * 1000), end: new Date(end * 1000) }
  }

  const policyBlock = takeSection(xml, "policy_published")
  if (policyBlock) {
    out.policy = {
      p: takeTag(policyBlock, "p") as DmarcReport["policy"] extends infer P
        ? P extends { p?: infer T }
          ? T
          : never
        : never,
      sp: takeTag(policyBlock, "sp") as "none" | "quarantine" | "reject" | undefined,
      adkim: takeTag(policyBlock, "adkim") as "r" | "s" | undefined,
      aspf: takeTag(policyBlock, "aspf") as "r" | "s" | undefined,
      pct: Number(takeTag(policyBlock, "pct")) || undefined,
    }
  }

  const recordRegex = /<record>([\s\S]*?)<\/record>/g
  let m: RegExpExecArray | null
  while ((m = recordRegex.exec(xml)) !== null) {
    const block = m[1]!
    records.push({
      sourceIp: takeTag(block, "source_ip"),
      count: Number(takeTag(block, "count")) || 0,
      disposition: takeTag(block, "disposition") as DmarcRecord["disposition"],
      dkim: takeTag(block, "dkim") as DmarcRecord["dkim"],
      spf: takeTag(block, "spf") as DmarcRecord["spf"],
      headerFrom: takeTag(block, "header_from"),
    })
  }
  return { ...out, records }
}

function takeTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, "i")
  const m = re.exec(block)
  return m ? m[1]!.trim() : undefined
}

function takeSection(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i")
  const m = re.exec(block)
  return m ? m[1] : undefined
}
