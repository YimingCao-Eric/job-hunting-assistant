const PROVINCE_ABBR = {
  Ontario: 'ON',
  'British Columbia': 'BC',
  Quebec: 'QC',
  Alberta: 'AB',
  Manitoba: 'MB',
  Saskatchewan: 'SK',
  'Nova Scotia': 'NS',
  'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL',
  Newfoundland: 'NL',
  'Prince Edward Island': 'PE',
  'Northwest Territories': 'NT',
  Nunavut: 'NU',
  Yukon: 'YT',
  California: 'CA',
  'New York': 'NY',
  Texas: 'TX',
  Washington: 'WA',
  Florida: 'FL',
  Illinois: 'IL',
  Massachusetts: 'MA',
  Colorado: 'CO',
}

const REGION_CODE_MAP = {
  NAMER: 'North America',
  EMEA: 'Europe / Middle East / Africa',
  APAC: 'Asia Pacific',
  LATAM: 'Latin America',
}

const WORK_MODE_RE = /\s*\((remote|hybrid|on-site|onsite|on site)\)\s*$/i

/**
 * Normalise location for display (strip work mode, postals, region codes, etc.).
 */
export function normaliseLocation(location) {
  if (!location) return null

  // 1. Strip work-mode suffix
  let loc = location.replace(WORK_MODE_RE, '').trim().replace(/,\s*$/, '').trim()

  // 2. Strip Canadian postal codes (A1A 1A1)
  loc = loc.replace(/,?\s*[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/gi, '').trim()

  // 3. Strip US ZIP codes
  loc = loc.replace(/,?\s*\d{5}(-\d{4})?\s*$/, '').trim()

  // 4. Map LinkedIn region codes (exact match after prior steps)
  const regionKey = loc.trim()
  if (REGION_CODE_MAP[regionKey]) return `${REGION_CODE_MAP[regionKey]} (Remote)`

  // 5. "Canada" alone → not useful
  if (loc === 'Canada') return null

  // 6. Abbreviate province/state names
  const parts = loc.split(',').map((p) => p.trim())
  loc = parts.map((p) => PROVINCE_ABBR[p] ?? p).join(', ')

  // 7. Strip trailing ", Canada"
  loc = loc.replace(/,\s*Canada\s*$/i, '').trim()

  return loc || null
}
