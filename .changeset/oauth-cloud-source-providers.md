---
"@ifc-lite/plugin-api": minor
---

Adds OAuth as a supported auth mode for file-source plugins: `PluginManifest.auth?: 'preferences' | 'oauth'` lets a provider declare it needs OAuth instead of a static preferences form, and `PluginContext.getAccessToken?()` gives OAuth-mode providers a live access token — the host owns the connect/refresh flow, the provider just adds its own `Authorization` header.
