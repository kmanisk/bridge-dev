# Optional third-party transports

connect defaults to an account-free Cloudflare Quick Tunnel. Cloudflare is an
external hosted relay. Its HTTPS address changes; Bridge verifies health,
protected-resource metadata, issuer/endpoints and the unauthenticated MCP challenge
before printing success. This is a reachability check, not proof of authorization
or of AI-client compatibility. The local listener stays on 127.0.0.1.

A tunnel exit, or three failed periodic endpoint verifications, stops advertising
the endpoint. Only the owned process group is terminated. Retry delay doubles from
one second to at most 30 seconds, bounded by Ctrl-C or the idle deadline. A new
origin invalidates old OAuth credentials, cancels consent, and revokes privileged
grants. Update each connector and reauthorize. Privileges require a new connect
startup authorization. Stable-origin reconnection preserves application sessions.

bridge-dev tunnel setup can select quick again or guide native named-tunnel
creation. Named setup requires a Cloudflare account and a domain under its DNS
control. It explicitly confirms login/create/DNS routing. cloudflared owns browser
login and credential management; Bridge saves only name and HTTPS origin. Setup
does not start a public tunnel. Named tunnel removal/DNS cleanup remains a native
Cloudflare account administration action; Bridge never deletes unrelated tunnels.

For another provider, configure tunnel="custom:/absolute/executable", public_origin
as an explicit HTTPS origin, and tunnel_argv as a TOML argv array whose first entry
matches the executable. Placeholders are {local_url}, {local_port}, {public_host}.
There is no shell parsing. The selected native program is trusted user configuration
and runs with the user's own permissions. Bridge validates and verifies its origin;
it does not infer issuer identity from forwarded/Host headers. Use tunnel="none"
for loopback-only OAuth development without a relay.

No public tunnel, account login or DNS change runs during automated tests. Fake
processes and loopback-only HTTPS-origin proxies cover startup, exit/restart,
origin-bound token invalidation, grant revocation and metadata consistency.
