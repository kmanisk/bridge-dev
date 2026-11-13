# First-run BridgeDev testing (without touching production)

This walkthrough starts a temporary portable instance, **not** the previously installed Linux system service.

## 1. Build the current source

Use an unprivileged terminal with Node.js 24, pnpm 12 and Git:

~~~sh
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
~~~

If you already have the checkout, inspect \`git status --short\` before updating and preserve any local changes.

## 2. Start the isolated trial

~~~sh
pnpm run try:local -- --show-secrets
~~~

The launcher creates a temporary directory and two free loopback ports. Its output gives the **Admin UI**, **Private MCP URL**, and **Private admin token**.

- Browse to the printed admin URL. Log in with the temporary admin token.
- Inspect the empty MCP provider registry and skills/settings interface.
- Test discovery of a reviewed source without installing arbitrary binaries.
- To test MCP protocol behavior, configure a **local** MCP client with the printed private URL, or run the automated smoke test:

~~~sh
pnpm run test:trial
~~~

The automated test runs an independent fixture on its own ports and verifies startup, localhost-only authentication, MCP initialization and cleanup.

## 3. Stop and clean up

Type \`quit\` into the trial terminal (or press Ctrl-C). The foreground process shuts down, deletes its temporary project and credentials, and releases both ports.

This trial does **not** start a systemd user/system service, modify installed source, add a tunnel, edit production credentials, or change any Git repository. It keeps the original Local Coder/Policy Gateway service listening on its existing port.

## 4. Testing from ChatGPT Web

ChatGPT is a remote service and cannot connect to \`127.0.0.1\` on your laptop. **Do not replace your production Funnel or paste trial credentials into a public issue.**

Use a separate operator-reviewed HTTPS endpoint that forwards **only** to the disposable MCP port. Keep the admin port bound to localhost. Then create a separate test connector in ChatGPT using that HTTPS MCP URL. If a client requires OAuth rather than a bearer header/token URL, verify its connector requirements first.

Use a fresh ChatGPT/Codex session and verify: initialize, tools/list, read-only fixture operations, then explicitly reviewed extension proposals. Some clients cache tool lists and require a refresh after you enable a provider.

## 5. Limits

- The portable trial uses your current OS account and is not a kernel sandbox. Do not enable untrusted MCP executables or run unreviewed scripts.
- Native GitHub/CI fixtures already cover Linux, Windows and macOS. This local step checks *your* machine without replacing production.
- Android/Termux hardware, real third-party accounts, private Git and community registries remain separately unverified.
- If a ChatGPT Local Coder app call says \`POLICYGATE_CONTEXT_REQUIRED\` but \`system_context\` is missing from its exposed tools, refresh/reconnect that **existing connector** in a fresh chat. That is a stale-client tool manifest problem, not a reason to stop production.
