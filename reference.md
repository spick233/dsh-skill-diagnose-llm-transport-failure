# Reference: generic LLM transport failures

## Where the sentence comes from

The DeepSeek adapter collapses every non-typed exception into one message. Paths are relative to `resources/app/` of a DSH Desktop install; line numbers are from `@deepseek-ai/dsh-llm-deepseek` 0.2.0-rc.2 and shift between releases.

| Site | What it does |
|---|---|
| `node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`, `DeepSeekAdapter.generate()` (≈2132) | `catch` wraps anything that is not `LlmError`, not an idle timeout and not an abort as `new LlmError("DeepSeek Messages transport failed", "TRANSPORT", { cause })`. The cause is alive here. |
| same file, Files API path (≈667) | Same pattern with ``DeepSeek Files API request to ${this.baseURL} failed``. |

From there the diagnostic detail is dropped by contract, not by a careless log line:

| Site | Effect |
|---|---|
| `node_modules/@deepseek-ai/dsh-llm/lib/index.js`, `LlmError` constructor (≈1631) | `this.failure` is frozen to `{message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`. `cause` is not a member, so it cannot survive serialization. |
| same file, `normalizeLlmFailure()` (≈402) | Returns the carried snapshot verbatim (`if (carried !== void 0 && carried.code === ownErrorCode(error)) return carried;`), so the live error is never re-inspected. |
| `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`, `step()` (≈1133) | `finish.failure` flows into `agent/request-error`, `llm/retry`, `turn/end`, the `[dsh-agent-error]` log line and the client UI — all carrying only `{message, code}`. |

Consequence: `SELF_SIGNED_CERT_IN_CHAIN`, `ECONNRESET`, `ENOTFOUND`, `UND_ERR_SOCKET` and a genuine provider outage are indistinguishable to the user and in any saved session.

## The retry arithmetic behind "retry delay N ms"

Recorded in the session as `llm/retry`. A typical DeepSeek policy key:

```json
["normal", 5, ["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"], 500, 10000, 0.1]
```

= mode `normal`, 5 retries, those codes are retryable, initial delay 500 ms, max delay 10000 ms, jitter ratio 0.1.

```
delay = min(initial * 2 ** (retry - 1), max) * (1 - jitter + 2 * jitter * random())
      = min(..., max)
```

so the five delays land near 541, 949, 1853, 3774, 8327 ms. A provider `Retry-After` header wins over the formula when it is present and at most `maxDelayMs`; longer than that, a `normal` policy gives up instead of clamping.

Numbers therefore do not indicate backoff health. A fast failure (~150–250 ms) repeated across attempts means the failure happens at handshake or connect time, before any token is streamed — the signature of a TLS or routing problem, not of a slow model.

## Log and session locations

| What | Where |
|---|---|
| Host log | Windows `%APPDATA%\DSH Desktop\logs\host\dsh-YYYY-MM-DD.log` and `…\dsh-YYYY-MM-DD.error.log`; macOS `~/Library/Application Support/DSH Desktop/logs/host/`; Linux `~/.config/DSH Desktop/logs/host/` |
| Desktop shell log (one directory up) | same root without the `host` segment; fewer entries |
| Session transcript | `%USERPROFILE%\.dsh\sessions\<workspace-slug>\<session-id>\session.v4.jsonl.zstd` |

The transcript is concatenated zstd frames, so a whole-stream decoder stops at the first frame boundary. Scan for the magic `28 B5 2F FD` and inflate each slice; the payload is JSONL with `llm/retry`, `assistant/attempt` and `turn/end` records carrying the same `{message, code}`.

## Why the browser works while model calls fail

Chromium (the window, the settings pages) trusts the Windows/macOS certificate store. The DSH host runs as an Electron **utility process** — a Node runtime — and Node verifies against its own bundled roots, which excludes any locally installed interception root.

The host is forked with the full environment:

```js
// resources/app/lib/main.js
const child = utilityProcess.fork("./host-process-entry.js", [], { env: { ...process.env } });
```

So a user-scope `NODE_EXTRA_CA_CERTS` reaches the model fetch — but only after the app is fully restarted, because the variable is read when the Node TLS stack initializes. The pnpm materializer subprocess is the one place these variables are stripped intentionally (`MATERIALIZER_STRIPPED_ENV_KEYS`); it is unrelated to model calls.

## Fix recipes

**A. Exclude the host from encrypted-connection scanning.** Most direct, keeps the protection for everything else. For Kaspersky 21.x the working path is 设置 → 安全 → 网络 → 加密连接扫描 → 管理排除项, adding both `deepseek.com` and `*.deepseek.com` (a bare domain mask does not always cover the apex). The general 威胁与排除项 list does **not** govern TLS scanning in that version. A server-side exclusion applies to the next connection, so no restart is needed.

**B. Trust the interception root for Node.** Export the existing root — never generate one — to PEM, then set user env `NODE_EXTRA_CA_CERTS` to that file and restart the app:

```powershell
$cert = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -match 'Kaspersky' }
$pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"
Set-Content -Path "$env:USERPROFILE\.dsh\certs\interceptor-root.pem" -Value $pem -Encoding ascii
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', "$env:USERPROFILE\.dsh\certs\interceptor-root.pem", 'User')
```

Trade-off to state out loud: Node then accepts anything that root signs, which mirrors the trust the browser already grants. If the product later rotates its root, the pinned PEM goes stale and the failure returns.

**C. Verify.** Probe again (all verified) *and* make one real request in the app. With intermittent interception, one clean probe proves nothing.

## Restoring observability (optional, local)

Two edits in the adapter restore the cause without changing behaviour — the failure stays `TRANSPORT`, so `retryPolicy.retryableCodes`, retry counts and UI rendering are untouched:

```js
/** Describe a transport failure's underlying cause chain. */
function describeTransportCause(error) {
	const parts = [];
	let current = error;
	for (let depth = 0; current !== void 0 && current !== null && depth < 4; depth++) {
		const code = typeof current.code === "string" && current.code !== "" ? current.code : void 0;
		const raw = typeof current.message === "string" ? current.message.trim() : "";
		const message = raw !== "" && raw !== "fetch failed" ? raw : void 0;
		const label = [code, message].filter((value) => value !== void 0).join(": ");
		if (label !== "" && parts[parts.length - 1] !== label) parts.push(label);
		current = typeof current === "object" ? current.cause : void 0;
	}
	return parts.length === 0 ? "" : ` (${parts.join(" <- ")})`;
}

throw new LlmError(`DeepSeek Messages transport failed${describeTransportCause(error)}`,
                   "TRANSPORT", { cause: error });
```

Yields `DeepSeek Messages transport failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain)`.

This lives inside `resources/app/node_modules`, which an app update replaces wholesale — re-apply afterwards, or prefer the structural upstream fix: an optional bounded `causeDetail` on `LlmFailure`, populated in `normalizeLlmFailure()`, logged with the agent error and shown behind the failure's details.

## What not to conclude

- A provider outage while a browser on the same machine reaches the API: the difference is the trust store, not the network.
- A dead network when the probe completes handshakes: certificate rejection happens after TCP and TLS reach the peer.
- Anything from a single clean probe when the original failure was intermittent — the interceptor may simply have skipped those connections.
