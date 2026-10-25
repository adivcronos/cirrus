# Cirrus

A desktop chat UI for the [Claude Code](https://claude.com/claude-code) CLI. Cirrus runs the `claude` program you already have installed and shows its work as a chat: streaming replies, collapsible tool steps, permission prompts, and your past conversations.

Builds for Windows, macOS and Linux come from GitHub Actions (see Releases).

## Sign-in

Cirrus never signs you in itself. It hands one of these to the CLI:

- **OAuth token**: a long-lived token from `claude setup-token`. Paste it in Settings (it's stored encrypted on your computer), or set `CLAUDE_CODE_OAUTH_TOKEN` in your environment.
- **Full login**: the account you sign into with `claude auth login`. Settings has a button for this.

## Remote Control

Two ways to reach this computer's Claude Code from your phone:

- **Cirrus Remote** (runs on your token): turn it on in the Remote Control panel and scan the QR code. Cirrus serves the same chat to your phone's browser, live-synced with the desktop window (messages, Allow / Deny, Stop). It works on the same Wi-Fi, or from anywhere through [Tailscale](https://tailscale.com). The link has a secret key in it; "New link" cancels old ones.
- **Claude's official Remote Control**: runs `claude remote-control` for claude.ai and the Claude app. It needs a full login, because long-lived tokens are inference-only.

## Requirements

- Claude Code installed (`claude` on your PATH, or set its location in Settings)

## Develop

```bash
npm install
npm start
npm run dist   # builds installers for the current OS into dist/
```

Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn the first time you open them.
