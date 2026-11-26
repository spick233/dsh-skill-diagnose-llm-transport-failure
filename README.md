# diagnose-llm-transport-failure

[![check](https://github.com/spick233/dsh-skill-diagnose-llm-transport-failure/actions/workflows/check.yml/badge.svg)](https://github.com/spick233/dsh-skill-diagnose-llm-transport-failure/actions/workflows/check.yml)

**English** | [中文](README.zh.md)

A [DSH](https://platform.deepseek.com) skill for the moment a model request dies with:

```
DeepSeek Messages transport failed
```

That sentence names no cause. On a desktop machine it is very often **local TLS interception** — an antivirus or enterprise proxy re-signing the connection with a root that Chromium trusts (it lives in the OS store) and Node/Electron does not (it verifies against its own bundled roots). The browser opens the API fine; the model call fails at the handshake, every retry re-handshakes, so it looks intermittent and "fixes itself" on retry.

This skill replaces guessing with a 30-second probe: it resolves the host, completes real handshakes, reads the presented certificate chain, reports whether each one verifies, and names the fix for the class of failure it proves.

## What is in here

| Path | Purpose |
|---|---|
| `SKILL.md` | The workflow the agent follows: probe → classify → fix → verify. Includes a `Never` list for the conclusions that waste hours. |
| `reference.md` | Loaded only when needed: where the cause is dropped in the code, how the retry delays are computed, log and session locations, Node-vs-Chromium trust, both fix recipes. |
| `scripts/tls-probe.mjs` | Diagnostics. No dependencies, no credentials, no writes. |
| `scripts/find-transport-failures.mjs` | Summarizes the DSH Desktop host logs: one file per date, counts plus recent lines. |

## Install

The skill is discovered from `~/.dsh/skills/<name>/SKILL.md`, so clone it to that path:

```powershell
# Windows
git clone https://github.com/spick233/dsh-skill-diagnose-llm-transport-failure "$env:USERPROFILE\.dsh\skills\diagnose-llm-transport-failure"
```

```bash
# macOS / Linux
git clone https://github.com/spick233/dsh-skill-diagnose-llm-transport-failure ~/.dsh/skills/diagnose-llm-transport-failure
```

Start a new DSH session (or restart the app). It then appears in the skill catalog and triggers on transport failures.

## Use

Ask the agent to diagnose the failure and the skill loads on its own. To probe a host directly:

```bash
node scripts/tls-probe.mjs api.deepseek.com 5
```

The second argument is rounds per resolved address — use `5` normally, `8` when the failure is intermittent, because an interceptor does not have to touch every connection.

```
host: api.deepseek.com
addresses: 60.204.2.5, 60.204.2.4
NODE_EXTRA_CA_CERTS: (not set)

60.204.2.5 #1  NOT VERIFIED  issuer=Kaspersky Anti-Virus Personal Root Certificate  TLSv1.3  SELF_SIGNED_CERT_IN_CHAIN  [interception]
60.204.2.5 #2  VERIFIED      issuer=GeoTrust TLS RSA CA G1  TLSv1.3
...
VERDICT: a Node/Electron fetch on this host throws for these connections.
CAUSE: TLS is being decrypted locally by security software or a proxy (...).
FIX:   exclude this host from that product's encrypted-connection scanning, ...
```

| Exit code | Meaning |
|---|---|
| `0` | Every handshake verified. Certificate trust is not the cause. |
| `1` | At least one verification failed — this is what makes `fetch` throw. |
| `2` | Nothing reachable, or the host does not resolve. Reachability, not trust. |

The probe talks to port 443 with SNI for the given hostname, never sends application data, and never uses a credential. It also reports interception that is *trusted*, because a working handshake through a proxy means the certificate is not the problem.

## Supported failures

- TLS interception by antivirus / enterprise proxy (the common case)
- Untrusted or malformed chain: clock skew, missing intermediate, stale CA bundle
- DNS failure (`ENOTFOUND`)
- Egress block, proxy requirement, provider outage
- "All verified but the app still fails" → the skill redirects to the failure's own `code` and `reference.md`

Tested on Windows 11 with DSH Desktop 2.0.17 / Electron 44. The scripts are plain Node (20+) and run anywhere; the log summarizer knows the Desktop log locations for Windows, macOS and Linux.

## Why not just fix the error message?

Because the cause is dropped by contract, not by a stray `console.log`: the adapter attaches it as `cause`, the `LlmError` snapshot keeps only `{message, code}`, and normalization returns that snapshot verbatim — so the UI, the retry events and the saved session all carry the same opaque string. `reference.md` has the exact locations and a small local patch that restores the cause, plus the structural fix worth sending upstream.

## A real case

On one Windows machine, 2 of 15 requests failed within 183 ms / 194 ms, and the log held only `[TRANSPORT]: DeepSeek Messages transport failed`. Six retries in a row failed the same way and the turn died; the browser on the same machine reached the same API without trouble.

The probe showed the certificate being replaced: 4 of 6 handshakes presented `Kaspersky Anti-Virus Personal Root Certificate`, and the "working" attempts were simply the ones that escaped interception. After adding the host to the product's encrypted-connection scanning exclusions, 10/10 handshakes carried the real chain and 15/15 requests succeeded — without disabling the antivirus and without weakening any verification.

## License

MIT
