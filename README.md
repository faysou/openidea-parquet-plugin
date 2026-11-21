# Parquet Viewer for OpenIDEA

Open a `.parquet` file to browse rows, inspect nested columns, and see the file's
row count and compression codecs. The viewer reads the footer and the data it
needs for the requested rows. It keeps 64-bit integers exact and distinguishes
nulls from text.

## Link a checkout for development

Use an OpenIDEA build that supports binary web custom editors and provides
`openidea.document.size()` and `openidea.document.readRange()`. The plugin also
needs Node.js, pnpm, and the `openidea-plugin` CLI.

```bash
pnpm install --frozen-lockfile
pnpm build
openidea-plugin check .
openidea-plugin link .
```

Reload plugins in **Settings > Plugins**, then open a Parquet file. For a dev
build with isolated app data, set `OPENIDEA_PLUGINS_DIR` to that build's plugins
directory before running `openidea-plugin link .`.

To create an installable package, run `openidea-plugin pack .` after the build.
In a compatible OpenIDEA build, use **Settings > Plugins > Install Plugin from Disk**
and select the `.oiplugin` file.

## Preview limits

Files can exceed the IDE's whole-file limit. A page can still require more data
than the viewer can safely hold when a file has unusually large row groups,
pages, or metadata. The viewer reports an error for those sections.

Run the decoder tests with `pnpm test`.
