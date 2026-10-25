# miband-health MCP server (local)

Lets your AI agent (Claude Code, Claude Desktop, any MCP client) analyse the health data you
downloaded from the **Health data** section of MiBand Hack. It reads the exported JSON from disk
and never sends anything anywhere.

- stdio, newline-delimited JSON-RPC, **no dependencies, no build step**
- Node **22.18 or newer**: the tools live in `src/health/query.ts` (shared with the cloud API),
  which Node loads directly through its built-in TypeScript type stripping. Run it from a checkout
  of this repository.

## Use

1. In the webapp: connect the band → **Health data** → **Fetch from band** → **Download JSON**.
2. Point the server at the file, or at a folder: every `miband-health/1` JSON in it is merged, and
   newer files win for records with the same time. Files are re-read when they change, so a fresh
   download is picked up without restarting.

### Claude Code

```bash
claude mcp add miband-health -e HEALTH_DATA=$HOME/Downloads/miband-health-2026-10-25.json \
  -- node /path/to/miband-hack/tools/health-mcp/server.js
```

### Claude Desktop and other clients (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "miband-health": {
      "command": "node",
      "args": ["/path/to/miband-hack/tools/health-mcp/server.js"],
      "env": { "HEALTH_DATA": "/path/to/health-exports" }
    }
  }
}
```

The path can also be given as the first argument instead of `HEALTH_DATA`.

## Tools

| Tool | What |
|---|---|
| `data_info` | Coverage per record kind (count, first, last), units, timezone, which band files were only partly decoded or kept raw. Call first. |
| `summary` | Per local day: steps, distance, active kcal, heart rate avg/min/max, SpO₂, stress, sleep minutes, workouts, plus the band's own daily summaries |
| `heart_rate`, `spo2`, `stress` | Series bucketed by `resolution` (avg/min/max/n), or `raw` samples with their source |
| `steps` | Steps, distance, active kcal per bucket (default per day) and the band's daily totals |
| `sleep` | Sessions with stage minutes, score and stage changes (`stages: false` omits them) |
| `workouts` | Sport, times, duration, kcal, distance, steps, heart rate |
| `records` | Raw query: the stored records of one `kind` in a range, paged with `limit` / `offset` |

Common arguments: `from`, `to` (`YYYY-MM-DD` = whole UTC days, or ISO 8601), `days` (default 7),
`resolution` (`raw, minute, 5min, 15min, hour, day, auto`), `tz_offset_minutes` (for day buckets;
default is the band's timezone). Responses are capped at 5000 points.

The format and its caveats (what is decoded, units, assumptions) are described in
[`docs/health-data.md`](../../docs/health-data.md).
Everything runs on your machine; no health data is sent anywhere.

## Test

`npm test` at the repository root runs `test/health-mcp.test.ts`, which starts this server as a
child process and talks to it over stdio.
