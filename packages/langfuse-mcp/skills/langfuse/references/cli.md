# Langfuse CLI Reference

Documentation: https://langfuse.com/docs/api-and-data-platform/features/cli

## Install

```bash
bunx langfuse-cli api <resource> <action>

# Or install globally
npm i -g langfuse-cli
langfuse api <resource> <action>
```

## Discovery

```bash
bunx langfuse-cli api --help
bunx langfuse-cli api <resource> --help
bunx langfuse-cli api <resource> <action> --help
bunx langfuse-cli api <resource> <action> --curl
```

## Credentials

bunx automatically loads the project `.env` file. Ensure it contains:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
# Cloud or local lite (dev often 23432; production CLI default 23332)
LANGFUSE_HOST=https://cloud.langfuse.com  # or http://localhost:<LITE_SERVER_PORT>
# LANGFUSE_BASE_URL is an alternative; if both are set, LANGFUSE_HOST takes precedence in bundled scripts
```

See repository root `.env.example` for `LITE_SERVER_PORT` and the four Langfuse variables. For local lite, `LANGFUSE_HOST` must match the port the server actually listens on.

## Tips

- Use `--json` for machine-readable JSON output
- Use `--curl` to preview the HTTP request without executing
- Pagination: use `--limit` and `--page` on list endpoints
- All list commands support filtering — check `<resource> <action> --help` for available options
- Resource names vary by installed CLI version; discover them with `api --help` instead of assuming version-specific aliases
- For traces and observations, prefer the bundled project scripts when their pagination and field projection match the task
