export function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::';
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function normalizeLoopbackHost(host) {
  if (!host) {
    return host;
  }
  return isLoopbackHost(host) ? 'localhost' : host;
}

// Use localhost for connectable loopback and wildcard addresses in browser-facing URLs.
export function getConnectableHost(host) {
  if (!host) {
    return 'localhost';
  }
  return isWildcardHost(host) || isLoopbackHost(host) ? 'localhost' : host;
}

// Resolve a configured host to a literal address safe to pass to
// server.listen()/net binding. 'localhost' (and the bracketed IPv6 literal
// '[::1]') is a hostname, not an address: Node resolves it via DNS and binds
// ONLY the first address returned, which on many Linux hosts (this one
// included) is the IPv6 loopback '::1' - silently making the server
// unreachable via IPv4 clients/reverse proxies pointed at 127.0.0.1. Mapping
// loopback hostnames to the literal IPv4 address makes `HOST=127.0.0.1` (and
// an explicit `HOST=localhost`) bind a reliably IPv4-reachable address
// regardless of the host's DNS/getaddrinfo ordering. Real IP literals
// (including explicit '::1' or wildcard '0.0.0.0'/'::') pass through
// unchanged since Node binds those directly without a DNS lookup.
export function resolveBindHost(host) {
  if (!host) {
    return host;
  }
  return host === 'localhost' || host === '[::1]' ? '127.0.0.1' : host;
}
