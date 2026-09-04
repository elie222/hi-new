# Publishing the hi.new plugin

How to get `plugin/` listed on the Cursor Marketplace so Grok Bot can install it with one click.

## What ships

Single-plugin layout. The plugin root is this folder.

- `.cursor-plugin/plugin.json`: manifest. Declares the `HI_NEW_TOKEN` variable (JSON Schema under `variables`, required).
- `mcp.json`: remote HTTP server `https://hi.new/mcp` with `Authorization: Bearer ${HI_NEW_TOKEN}`.
- `skills/hi-new/SKILL.md`: bot instructions.
- `assets/logo.png`: marketplace logo.

The marketplace needs a public git repo it can read. Either publish this repo (the plugin sits at `plugin/`) or mirror `plugin/` to its own repo with the manifest at the root. Cursor's template says a single plugin keeps `.cursor-plugin/plugin.json` at the repository root and no `marketplace.json`. If we submit this monorepo, tell them the plugin root is `plugin/` and ask whether a subdirectory works or a separate repo is needed.

## Before submitting

1. Run the template validator. From a scratch dir, wrap `plugin/` in a marketplace manifest and run `node scripts/validate-template.mjs` from https://github.com/cursor/plugin-template. It passes as of 2026-09-03.
2. Confirm `https://hi.new/mcp` answers `POST` with a bearer token and returns `401 missing_bearer` without one. It does.
3. Bump `version` in `plugin.json` for every resubmission.

## Submit

1. Open https://cursor.com/marketplace/publish and follow the form (the page is a client-rendered app; the template README says the fallback is sending the repo link to the Cursor team on Slack or `kniparko@anysphere.com`).
2. Give them: repo URL, plugin root (`plugin/`), plugin name `hi-new`, display name `hi.new`, publisher Inbox Zero Inc., and the logo path.

## Ask the Cursor team

- Install prompt: confirm that a required variable in `plugin.json` `variables` makes Grok Bot show the `HI_NEW_TOKEN` field on install. Grok Bot's bundle renders plugin variable fields as inputs (password-masked when the name matches `TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL`) and refuses to install until required fields are filled, so this should work. Ask them to confirm it applies to personal (non-team) installs and to the `grokbot://app/v1/plugin/add` deeplink.
- Public listing: we want the plugin public, not team-only. Ask what review it needs and how long it takes.
- Numeric plugin id: once listed, ask for the plugin's numeric id. Grok Bot's deeplink is `grokbot://app/v1/plugin/add?id=<digits>` (1 to 19 digits). The same id appears as `?pluginId=` on `https://cursor.com/marketplace`. The deeplink resolves the id against the public catalog; an unlisted id shows "unavailable".
- Variables keywords: `variables` accepts a limited JSON Schema subset (`type`, `title`, `description`, `default`, `enum`, `const`, `properties`, `required`, `items`, length and numeric constraints). Confirm nothing else is needed for a secret string.

## Updating the plugin

Edit files under `plugin/`, bump `version`, push. The marketplace pins a commit, so ask the Cursor team how re-indexing works, or whether a tag or release is picked up on its own.
