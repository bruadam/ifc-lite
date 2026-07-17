# @ifc-lite/source-dropbox

Dropbox file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` to browse a
connected Dropbox account's folders and download IFC files directly into
the viewer.

Auth is OAuth (`manifest.auth: 'oauth'`) rather than a static preference —
the host runs the authorization-code consent flow and refresh, and this
provider only ever sees a short-lived access token via
`PluginContext.getAccessToken()`.

Dropbox has no "project" or "file area" concept, so `listProjects` returns a
single synthetic project and the top level of `listContainers` returns a
single synthetic root container standing in for the whole account.
