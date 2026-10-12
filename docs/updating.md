# Updating

When a newer version is on GitHub, `/crew` shows an update notice (it checks by itself every 6 hours; **Check for updates** in ⚙ Settings checks now). Press **Install update**: it downloads the new version straight from GitHub and copies it over the plugin's folder (curl, tar and robocopy come with Windows 10/11). That works however you installed crew, including a desktop-app upload, and needs no git or claude CLI. Your relay key and chat are never overwritten. Then restart Claude.

If it fails, the notice says which step and why, and every step is logged in `%TEMP%\crew-update.log`. A marketplace install then falls back to the claude CLI; a desktop upload says to reinstall from the GitHub zip.

> **On a version older than 0.9.4?** Its updater can fail on some PCs, so update once by hand: download the repo zip from GitHub and upload it again (or run the commands below). From then on, Install update does it for you.

The manual way, two terminal commands (**Copy commands** copies them):

```bash
claude plugin marketplace update claude-crew
```

```bash
claude plugin update crew@claude-crew
```

If the relay is older than the plugin, `/crew` says so. The host presses **Restart relay** there (after restarting Claude on the new version): the old relay stops and the new one starts, with the same key and chat.

**Maintainer: releasing a new version.** Run the script below. It bumps the version in `plugin.json`, `register.tsx` and `relay.py`, then validates the plugin and runs both test suites (the plugin's and the relay's), stopping if the relay tests fail. Then commit and push.

```bash
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 1.0.1
```

---
[← Back to the README](../README.md)
