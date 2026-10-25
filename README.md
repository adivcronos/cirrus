# Cirrus

A desktop chat UI for the [Claude Code](https://claude.com/claude-code) CLI. Cirrus runs the `claude` program you already have installed and shows its work as a chat: streaming replies, collapsible tool steps, permission prompts, and your past conversations.

Builds for Windows, macOS and Linux come from GitHub Actions (see Releases).

## Sign-in

Cirrus never signs you in itself. It hands one of these to the CLI:

- **OAuth token**: a long-lived token from `claude setup-token`. Paste it in Settings (it's stored encrypted on your computer), or set `CLAUDE_CODE_OAUTH_TOKEN` in your environment.
- **Full login**: the account you sign into with `claude auth login`. Settings has a button for this.

## Remote Control

Turn it on from the sidebar to reach this computer's Claude Code from claude.ai or the Claude mobile app. It runs `claude remote-control`, which only works with a **full login**. Long-lived tokens are limited to chatting.

## Requirements

- Claude Code installed (`claude` on your PATH, or set its location in Settings)

## Develop

```bash
npm install
npm start
npm run dist   # builds installers for the current OS into dist/
```

Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn the first time you open them.
