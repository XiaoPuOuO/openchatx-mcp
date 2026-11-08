# Tailscale mobile access (OpenChatX UI)

OpenChatX provides an **optional, disabled-by-default** UI-only connection for devices in the same Tailscale tailnet. OpenChatX **does not install Tailscale, sign in to a tailnet, configure VPNs, or publish the UI to the public internet**.

## Enable

1. Install and connect [Tailscale](https://tailscale.com/) yourself on the computer and mobile device.
2. Find the computer's Tailscale IPv4 in the Tailscale client (or run `tailscale ip -4`).
3. In **OpenChatX → Settings → General → Tailscale mobile access**, enable the feature and enter that computer's IPv4 (a `100.64.0.0/10` address). Save.
4. Visit `http://<computer-tailscale-ip>:<openchatx-port>/ui/` on another authorized tailnet device (default port `8001`).

Ordinary Tailscale installations require no further configuration. For nonstandard CLI installations or user-space daemons, the **Advanced** section offers an optional CLI executable path and Tailscale socket path. Only a connected pre-existing Tailscale installation is used.

## How it works

The OpenChatX runtime manages an HTTP reverse proxy bound to a random **loopback-only** port. It accepts only the configured tailnet Host and paths under `/ui`, rejects cross-origin mutation requests, and forwards valid requests to the local `127.0.0.1:<openchatx-port>` UI. The MCP server keeps its normal localhost Host validation.

OpenChatX uses **Tailscale Serve's private TCP forwarding** to map the computer's tailnet port to this loopback proxy. It never uses Tailscale Funnel or opens a router port. It refuses to replace an unrelated existing Tailscale Serve rule.

The optional feature is part of the packaged runtime; no standalone Node script or launch agent is needed. Its last owned forward is recorded in `<state_dir>/tailnet-ui-forward.json` (owner metadata only, no credentials), so restarts can safely distinguish the OpenChatX rule from unrelated rules.

## Disable or remove

Turn **OpenChatX → Settings → General → Tailscale mobile access → Off** and Save. OpenChatX removes its own Tailscale Serve mapping and stops its reverse proxy. A normal runtime shutdown leaves the owned Serve mapping in place for the next instance to reclaim; the mapped loopback port is temporarily unavailable during restart. The running app also reconciles the mapping periodically after Tailscale reconnects.

If OpenChatX is unavailable, first inspect the active mapping with `tailscale serve status`. Only if the mapping on the configured OpenChatX port is known to belong to OpenChatX should you remove it with `tailscale serve --tcp=<openchatx-port> off`. For a custom userspace Tailscale socket, prefix the CLI with `--socket=<your-path>`.

If OpenChatX crashes, Tailscale's Serve configuration may remain until the next app start; the stale mapping will normally point to a dead loopback proxy. OpenChatX reconciles its ownership record on the next startup.

## Security

The remote `/mcp` endpoint and all non-UI paths are blocked by the proxy. **The UI itself has administrative APIs, including write actions.** Any device permitted by your Tailscale access policy may be able to use them. Review your tailnet access controls; do not treat the UI as a read-only dashboard or make the forward publicly accessible.

The browser URL uses HTTP but its traffic travels inside Tailscale's encrypted tunnel. This protection does not extend to any services separately exposed outside Tailscale.
