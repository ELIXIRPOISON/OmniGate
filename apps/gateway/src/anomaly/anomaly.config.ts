/** Tunables for the heuristic pre-screen (docs/06 §4). Weights feed the noisy-OR combiner. */
export const SIGNAL_WEIGHTS = {
  injection_patterns: 0.9,
  // Weighted so a single unknown parameter name clears the 0.7 flag threshold on its own. It is the
  // strongest single detector measured: 50.4 percent of CSIC 2010 attacks with no false positive
  // across 36,000 held-out normal requests, where every other signal combined reaches 21.0 percent.
  // See docs/results/anomaly-eval-csic.md and anomaly/schema.service.ts for the safety rules that
  // keep it from firing on a route it has not learned yet.
  unknown_param: 0.85,
  body_size_z: 0.4,
  entropy: 0.5,
  burst: 0.6,
  path_enum: 0.6,
  ua_anomaly: 0.5,
  auth_failures: 0.7,
  method_mismatch: 0.3,
} as const;

export type SignalName = keyof typeof SIGNAL_WEIGHTS;

export type AttackCategory =
  | 'sqli'
  | 'xss'
  | 'traversal'
  | 'cmd_injection'
  | 'ssti'
  | 'scraping'
  | 'credential_stuffing'
  | 'enumeration'
  | 'dos'
  | 'other';

/** Curated injection signatures, evaluated over the lower-cased, URL-decoded path + query + body. */
export const INJECTION_PATTERNS: ReadonlyArray<{
  category: AttackCategory;
  name: string;
  re: RegExp;
}> = [
  // SQL injection
  {
    category: 'sqli',
    name: 'tautology',
    re: /(['"`]|\b)\s*(or|and)\s+['"`]?\w+['"`]?\s*=\s*['"`]?\w+['"`]?(\s*(--|#|\/\*))?/,
  },
  {
    category: 'sqli',
    name: 'union_select',
    re: /union(\s|\/\*.*?\*\/|\+)+(all(\s|\+)+)?select/,
  },
  {
    category: 'sqli',
    name: 'stacked_query',
    re: /;\s*(drop|delete|insert|update|alter|truncate|exec|shutdown)\b/,
  },
  {
    category: 'sqli',
    name: 'time_based',
    // WAITFOR DELAY takes a time string, not parentheses: `waitfor delay '0:0:15'`. Requiring a
    // paren after it missed 535 blind-injection requests in CSIC 2010.
    re: /\b(sleep|pg_sleep|benchmark)\s*\(|\bwaitfor\s+delay\s*['"(]/,
  },
  {
    category: 'sqli',
    name: 'comment_terminator',
    re: /['"]\s*(--|#)\s*$|['"]\s*\/\*/,
  },
  {
    category: 'sqli',
    name: 'info_schema',
    re: /information_schema|sysobjects|load_file\s*\(|into\s+(out|dump)file/,
  },
  // Cross-site scripting
  { category: 'xss', name: 'script_tag', re: /<\s*\/?\s*script\b/ },
  {
    category: 'xss',
    name: 'event_handler',
    re: /\bon(error|load|mouseover|focus|click)\s*=/,
  },
  { category: 'xss', name: 'js_uri', re: /javascript\s*:/ },
  {
    category: 'xss',
    name: 'html_injection',
    re: /<\s*(iframe|img|svg|object|embed)\b[^>]*(src|onerror)/,
  },
  // Path traversal
  {
    category: 'traversal',
    name: 'dot_dot',
    re: /(\.\.[\\/]){2,}|(\.\.[\\/]).*(etc[\\/]passwd|windows[\\/]win\.ini|boot\.ini)/,
  },
  {
    category: 'traversal',
    name: 'sensitive_file',
    re: /[\\/](etc[\\/](passwd|shadow)|proc[\\/]self[\\/]environ|\.git[\\/]config|wp-config\.php)\b/,
  },
  // Command injection
  {
    category: 'cmd_injection',
    name: 'shell_chain',
    re: /(;|\|\||&&|\|)\s*(ls|cat|id|whoami|uname|wget|curl|nc|bash|sh|powershell|ping)\b/,
  },
  {
    category: 'cmd_injection',
    name: 'subshell',
    re: /\$\([^)]*\)|`[^`]{1,80}`/,
  },
  // Response splitting. 266 requests in CSIC 2010, no benign match.
  {
    category: 'other',
    name: 'crlf_header_inject',
    re: /(\r\n|%0d%0a)\s*(set-cookie|location|content-length|content-type)\s*:/i,
  },
  // Poison null byte, the classic extension and filter bypass. 149 requests, no benign match.
  {
    category: 'traversal',
    name: 'null_byte',
    re: /%00|\u0000/,
  },
  // Probing for editor and deployment leftovers: index.jsp.INC, imagenes.BAK, logo.gif~.
  // 2,132 and 243 requests respectively in CSIC 2010, neither matching any of 72,000 benign rows.
  {
    category: 'traversal',
    name: 'backup_source_file',
    re: /\.(old|bak|backup|swp|orig|save|inc)(\b|$)/i,
  },
  {
    category: 'traversal',
    name: 'tilde_backup',
    re: /~(\s|$|\?)/,
  },
  // Server-side template injection
  {
    category: 'ssti',
    name: 'template_expr',
    re: /\{\{\s*[\w'"()*+\-/. ]{1,60}\s*\}\}|\$\{\s*[\w.()]{1,60}\s*\}|<%[=\s].{1,80}%>/,
  },
];

/** User agents of known scanners and attack tooling (docs/06 §4 ua_anomaly). */
export const SCANNER_USER_AGENTS = [
  'sqlmap',
  'nikto',
  'nmap',
  'masscan',
  'zgrab',
  'dirbuster',
  'gobuster',
  'dirb',
  'wfuzz',
  'ffuf',
  'nuclei',
  'acunetix',
  'nessus',
  'openvas',
  'havij',
  'w3af',
  'hydra',
  'burpsuite',
  'commix',
] as const;

export const HEURISTIC_THRESHOLDS = {
  /** Body-size z-score: 0 at z <= 2, 1 at z >= 6, and only once the route has this many samples. */
  bodyZMin: 2,
  bodyZMax: 6,
  bodyStatsMinSamples: 20,
  /** Shannon entropy (bits/char) ramp for text bodies of at least entropyMinBytes. */
  entropyLow: 4.6,
  entropyHigh: 5.2,
  entropyMinBytes: 64,
  /** Burst: requests by the principal in the last 10 s divided by the policy max. */
  burstWindowMs: 10_000,
  /** Distinct paths per principal in the last minute: 0 at <= pathEnumLow, 1 at >= pathEnumHigh. */
  pathEnumLow: 20,
  pathEnumHigh: 50,
  /** 401s per IP in the last minute: 0 at <= authFailLow, 1 at >= authFailHigh. */
  authFailLow: 3,
  authFailHigh: 10,
  /** ua_anomaly score when the header is missing. */
  missingUserAgent: 0.6,
} as const;

/** Redaction rules (docs/06 §3). */
export const REDACTION = {
  headers: [
    'authorization',
    'cookie',
    'x-api-key',
    'set-cookie',
    'proxy-authorization',
  ],
  sensitiveKey:
    /pass(word)?|secret|token|otp|cvv|card|ssn|aadhaar|pan|credential|private/i,
  bodyMaxChars: 2_000,
  queryMaxChars: 500,
  userAgentMaxChars: 200,
} as const;
