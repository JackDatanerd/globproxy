// One readable "Browser on OS" label for a stored user-agent string. Two copies
// of this lived in AccountSecurityCards and TrustedBrowsers and disagreed (Edge
// on Android, Opera and iOS Chrome were labelled differently in each).
export function shortUa(ua: string | null | undefined): string {
  if (!ua) return ''
  // Order matters: Edge/Opera/Samsung/Firefox-iOS/Chrome-iOS UAs all also say
  // "Chrome" or "Safari", so the specific tokens are tested first.
  const browser =
    /EdgA?\/|Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser'
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : ''
  return os ? `${browser} on ${os}` : browser
}
