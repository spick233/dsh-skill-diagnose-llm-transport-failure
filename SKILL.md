---
name: diagnose-llm-transport-failure
description: 'Use when model requests keep failing with an opaque transport error — "DeepSeek Messages transport failed", repeated "retry delay" notices, or a turn dying on [TRANSPORT] / [TIMEOUT] / [EMPTY_RESPONSE]. The visible message hides its cause, so diagnose from the endpoint instead of guessing: one bundled probe separates TLS interception, untrusted root, DNS, proxy and a real provider outage, and names the fix for each.'
---

# Diagnose a generic LLM transport failure

The adapter wraps every low-level exception into one fixed sentence, so the text a user sees carries no cause:

```
DeepSeek Messages transport failed
```

Never report "network problem" from that sentence. Probe the endpoint, classify, then fix. Most cases on a desktop machine are local TLS interception by security software — the browser works, the model call does not.

## 1. Probe the endpoint

```powershell
node '<skill-directory>\scripts\tls-probe.mjs' api.deepseek.com 5
```

When the user's report needs confirming first, `node '<skill-directory>\scripts\find-transport-failures.mjs'` summarizes the host logs: one file per date, counts plus the most recent lines, exit `1` when it finds any.

The probe's second argument is rounds per resolved address; use `5` normally and `8` when the failure is intermittent. For a non-DeepSeek route, pass the provider's host from its configured base URL instead. Exit `0` means every handshake verified, `1` means at least one verification failed, `2` means nothing could be reached or the host does not resolve.

The probe prints one line per handshake: address, verified or not, issuer CN, TLS version. Branch on the exit code, not on the issuer name alone — a successful handshake through an intercepting proxy still works.

## 2. Read the result

| Probe output | Cause | Fix |
|---|---|---|
| `NOT VERIFIED`, issuer is a security product or enterprise proxy (`Kaspersky`, `ESET`, `Avast`, `360`, `火绒`, `Sangfor`, `Zscaler`, `Netskope`, `Fortinet`, …) | Local TLS interception. Chromium trusts the Windows store where that root lives; Node/Electron does not. | Exclude the host from the product's encrypted-connection scanning; the product's own UI, not this skill. If the user wants scanning kept: export that root to PEM, set user env `NODE_EXTRA_CA_CERTS` to it, restart the app fully. |
| `NOT VERIFIED`, issuer is a public CA | Clock skew, missing intermediate, or a too-old CA bundle. | Check the system clock; update the app; re-probe. |
| `ENOTFOUND` / `getaddrinfo` | DNS. | Resolver, VPN, corporate DNS, `hosts` file. Probe a second host to see whether it is DNS-wide. |
| `ECONNREFUSED` / timeout on every address | Egress blocked, proxy required, or provider down. | Check proxy env (`HTTPS_PROXY`, `NO_PROXY`); confirm with a plain `https` GET; only then call it an outage. |
| All verified, app still fails | Not TLS. | Read the failure's `code` and any status; look at request size, provider 5xx, or the specific adapter. |

When interception is the cause, say so plainly: the traffic is being decrypted by the local security product, the model call fails at the handshake, and each retry re-handshakes — which is exactly why the failure looks intermittent and disappears on retry.

## 3. Install the fix, then verify

For the exclusion route, the user edits the product themselves; give the exact path for their product and version, and tell them a full app restart is needed only when an environment variable is involved — a server-side exclusion takes effect on the next connection, without a restart.

For the `NODE_EXTRA_CA_CERTS` route, export the intercepting root (do not generate one):

```powershell
$cert = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -match '<product name>' }
$pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"
Set-Content -Path "$env:USERPROFILE\.dsh\certs\<name>-root.pem" -Value $pem -Encoding ascii
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', "$env:USERPROFILE\.dsh\certs\<name>-root.pem", 'User')
```

Say what that trades: Node then accepts anything that root signs, which is the same trust the browser already grants. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` or disable verification.

Verify with the probe again — every handshake verified, interception still visible or not — and then with one real request in the app. A probe that is clean only because no connection happened to be intercepted proves nothing: when the product intercepts intermittently, require several clean rounds or a successful real request before declaring success.

## 4. Why the message is so opaque

Load `reference.md` when the user asks why the error cannot simply be read, when the failure must be reported upstream, or when the running build keeps hiding the cause. It has the wrap sites, the failure contract that drops `cause`, the retry arithmetic behind the delay numbers, and the log and session locations.

## Never

- report a cause without a probe result that supports it;
- call it a provider outage while a browser on the same machine can reach the API;
- disable certificate verification, or add a root the product did not issue;
- edit the security product's files or registry instead of its UI;
- claim success from a single clean probe when the failure was intermittent.
