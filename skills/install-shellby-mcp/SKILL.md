---
name: install-shellby-mcp
description: Install and verify Shellby MCP on a Mac using terminal access only. Use when a user asks an agent to install, set up, configure, or finish a new Shellby MCP installation from this repository.
---

# Install Shellby MCP

Install Shellby MCP collaboratively with the human.

## Boundaries

- Inspect current machine and repository state before changing anything. Resume partial installs instead of blindly repeating setup.
- Never ask the user to paste an ngrok authtoken, ChatGPT credential, or other secret into chat. Have them enter secrets directly in their own Terminal or browser.
- Give the human concise instructions whenever macOS, Chrome, ChatGPT, or another GUI requires interaction.
- Do not run `npm start`, `npm run restart`, `npm run status`, `npm run logs`, `npm run stop`, or a direct `pm2` command before the human establishes the PM2 daemon from Terminal.app. A PM2 command may create the daemon under the wrong macOS permission source.
- Never kill an existing PM2 daemon until you know what it manages and the human explicitly agrees to disrupt those processes. `pm2 kill` affects the whole user-level PM2 daemon, not only Shellby.
- Treat Computer Use permission status observed from the agent's own host process as non-authoritative for Terminal.app. macOS TCC permissions follow the responsible launching process.

## 1. Inspect the machine

Confirm:

- macOS on Apple Silicon or Intel;
- Node.js 22.13.0 or newer;
- `npm` and `git` are available;
- ngrok is installed;
- this repository is present and writable.

If the repository is not already checked out, clone `https://github.com/Serbyte-Development/shellby-mcp.git` and enter it.

Install missing prerequisites when safe. Prefer the repository's documented ngrok installation command when Homebrew is available:

```bash
brew install --cask ngrok
```

Do not silently replace the user's Node installation strategy or package manager. If Node is missing or too old and there is no obvious existing version manager, tell the human what is required and let them choose how Node should be installed. Never chat $PATH without explicit approval.

## 2. Install repository dependencies

From the repository root:

```bash
npm ci
```

Use `npm ci`, not `npm install`, for a normal install from the committed lockfile.

## 3. Establish ngrok authentication

Check ngrok without exposing credential contents:

```bash
ngrok config check
```

Then run:

```bash
npm run preflight
```

If ngrok is not authenticated, stop and ask the human to run this themselves in Terminal.app:

```bash
ngrok config add-authtoken <their-token>
```

Tell them to obtain the token from their own ngrok account if necessary (its free). Do not ask them to send the token to you. Continue only after they say authentication is complete, then rerun `npm run preflight`.

## 4. Create and review the active Shellby config

Create or migrate the complete active config before running side-effecting setup:

```bash
npm run setup -- --config-only
```

Review `.shellby/config.toml` with the human. Every Shellby-owned configurable value comes from this file. Edit values directly when the user wants a different workspace, shell, ChatGPT route, MCP tool-output format, or enabled tool groups. `shell.rtk` is optional; if the human enables it, RTK Token Killer must be installed and setup will validate the executable. External tools keep their own machine-level configuration; in particular, ngrok authentication stays in ngrok's normal user configuration.

## 5. Run non-PM2 setup

Run:

```bash
npm run setup
```

This prepares the workspace and builds Shellby. It checks Computer Use only when that tool group is enabled, and prepares/checks the dedicated ChatGPT Chrome profile only when clone or subagent tools are enabled.

Important:

- The Computer Use status shown here may reflect the installing agent's host process rather than Terminal.app. Do not treat it as proof that Terminal has the required permissions.
- If setup launches the dedicated Chrome window, ask the human to sign into ChatGPT in that window. The installing agent does not need to interact with Chrome.
- If Chrome is absent, browser-backed subagents remain optional and core Shellby can still be installed.

## 6. Hand Terminal-only actions to the human

Before touching PM2, inspect for an already-running user PM2 daemon without invoking PM2 itself. For example, check `~/.pm2/pm2.pid` and verify that PID is alive with normal process tools.

If no PM2 daemon is running, ask the human to open **Terminal.app**, `cd` to this repository, and keep that Terminal as the permission source for Shellby.

If Computer Use is desired, have the human first run:

```bash
npm run setup:computer
```

They should complete Peekaboo's macOS permission prompts from that Terminal context. Screen Recording enables observation; Accessibility and Event Synthesizing enable actions.

Then have the human run, from Terminal.app:

```bash
npm start
```

Do not run this command on their behalf from the agent's shell. The goal is for the PM2 daemon and Shellby process tree to originate from Terminal.app so the expected macOS permission source owns Computer Use access.

Ask the human to tell you when startup finishes and to share non-secret error text if it fails. They do not need to paste credentials or private identifiers.

### Existing PM2 daemon

If a PM2 daemon was already running before this installation, do not guess its origin and do not kill it automatically.

Tell the human that Shellby's Computer Use permission source depends on the existing daemon's launch context. Determine whether that daemon is intentional and whether it manages unrelated applications. If the human wants to recreate it from Terminal.app, have them inspect the existing PM2 applications first and explicitly approve disruption before using `pm2 kill`. After a deliberate recreation, `npm start` must be run from Terminal.app.

## 7. Verify the local runtime

After the human has run `npm start`, it is safe to use Shellby's PM2 status commands because the daemon has already been established by Terminal.app.

Verify:

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
npm run print-url
```

Confirm both `shellby-mcp` and `shellby-ngrok` are running and record the printed public `https://.../mcp` URL for the human. Use `npm run logs` only when diagnosis is needed.

If startup reports that the MCP server did not become healthy, inspect status and logs before changing configuration or recreating PM2.

## 8. Hand ChatGPT configuration to the human

The installing agent does not need browser control.

Ask the human to:

1. Enable ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
2. Create a new plugin using the printed `https://.../mcp` URL. Run `npm run print-url` to get the URL.

- To add a custom plugin, ChatGPT Developer Mode must be enabled and the human must use the desktop web app. From the Plugins UI, use the add button:
  ![Screenshot of the add plugin menu](../../docs/assets/add-plugin-menu-screenshot.png)
- Name the plugin something like "Shellby MCP" and add a description such as "Gives full access to my Mac".
- Enter the URL from `npm run print-url` in the URL field.
- Optionally add a logo/icon: ![Shellby MCP icon](../../docs/assets/icon-80_square-compressed.png)

3. Select **No Auth** for the plugin.
4. Enable or refresh the plugin so ChatGPT fetches Shellby's tool list.

After they do this, verify locally that `agent-commands.yaml` received a new `tools/list` entry. Do not display unrelated audit-log contents because tool inputs may be sensitive.

## 9. Verify first trusted tool use

Ask the human to start a fresh ChatGPT conversation with Shellby enabled. ChatGPT's first trusted remote `tools/list` already binds this installation to that ChatGPT user using their subject header. The first Shellby call should still be `start_here`; after it succeeds, make one simple follow-up call such as `shell_list` or running `pwd`.

Verify that `tools/list` reached Shellby from the audit log and that `~/.shellby/auth.json` now exists. Do not print the stored subject value.

Use `npm run auth:reset` only when the human intentionally wants to clear that binding. (This MCP can only bind to a single ChatGPT user.)

## 10. Verify optional capabilities

### Computer Use

If the human enabled Computer Use, have them test one read-only Computer Use operation through ChatGPT. If permissions fail, have them run the Peekaboo permission workflow again from Terminal.app and follow the source reported by Peekaboo. Do not try to solve TCC mismatches by repeatedly granting permissions from the agent's own process.

### Browser-backed subagents

If Chrome is installed, confirm the dedicated ChatGPT Chrome profile is signed in. `npm run setup` normally prepares it; `npm run setup:chatgpt` can rerun that setup explicitly. The human handles any required browser sign-in.

Then have the human exercise one subagent request through ChatGPT if they want that capability verified.

## Completion criteria

Do not call the installation complete until:

- `npm run preflight` passes;
- `npm run setup` has completed;
- the human has established the PM2/Shellby runtime from Terminal.app;
- `shellby-mcp` and `shellby-ngrok` are running;
- `/healthz` succeeds;
- a public `/mcp` URL is available;
- ChatGPT has fetched `tools/list` from the custom app;
- at least one trusted Shellby tool call succeeds.

Computer Use and browser-backed subagents are optional capabilities. If the human chooses not to configure one of them, state that clearly rather than treating the core installation as failed.
