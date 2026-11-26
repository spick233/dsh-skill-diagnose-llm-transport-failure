#!/usr/bin/env node
/**
 * Probe TLS trust for one host and classify what a Node/Electron fetch would hit.
 * One handshake per attempt: the socket never rejects, so `authorized` still
 * reports the real verification result while the peer certificate stays readable.
 *
 * Usage: node tls-probe.mjs <host> [roundsPerAddress]
 *
 * Exit codes:
 *   0  every handshake verified (interception may still be present, but trusted)
 *   1  at least one handshake failed verification — this is what makes fetch throw
 *   2  nothing reachable / host does not resolve — a different problem entirely
 */
import dns from "node:dns/promises";
import process from "node:process";
import tls from "node:tls";

const host = process.argv[2];
const rounds = Number(process.argv[3] ?? 5);

if (!host) {
	console.error("usage: node tls-probe.mjs <host> [roundsPerAddress]");
	process.exit(2);
}
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
	console.error("roundsPerAddress must be an integer from 1 through 20");
	process.exit(2);
}

/** Security products and enterprise proxies known to re-sign TLS locally. */
const INTERCEPTOR = /kaspersky|eset|avast|avira|avg|bitdefender|qihoo|360|huorong|火绒|sangfor|深信服|zscaler|netskope|fortinet|sophos|mcafee|symantec|trend ?micro|comodo|adguard|fiddler|charles|mitmproxy|proxyman|burp/i;

let addresses;
try {
	addresses = await dns.resolve4(host);
} catch (error) {
	console.error(`cannot resolve A records for ${host}: ${error.code ?? error.message}`);
	console.error("this is a DNS failure, not a TLS failure");
	process.exit(2);
}
if (addresses.length === 0) {
	console.error(`${host} resolved to no IPv4 addresses`);
	process.exit(2);
}

console.log(`host: ${host}`);
console.log(`addresses: ${addresses.join(", ")}`);
console.log(`NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS ?? "(not set)"}`);
console.log("");

function attempt(address) {
	return new Promise((resolve) => {
		const socket = tls.connect(
			{ host: address, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 },
			() => {
				const issuer = socket.getPeerCertificate(true)?.issuer?.CN ?? "(unknown)";
				const protocol = socket.getProtocol() ?? "?";
				const verified = socket.authorized === true;
				const authorizationError = socket.authorizationError ?? undefined;
				socket.end();
				resolve({ outcome: verified ? "verified" : "rejected", issuer, protocol, authorizationError });
			},
		);
		socket.once("error", (error) => {
			resolve({ outcome: "unreachable", code: error.code ?? error.name, message: error.message });
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve({ outcome: "unreachable", code: "ETIMEDOUT", message: "handshake timeout" });
		});
	});
}

const tally = { verified: 0, rejected: 0, unreachable: 0 };
const issuers = new Map();

for (const address of addresses) {
	for (let round = 1; round <= rounds; round++) {
		const result = await attempt(address);

		if (result.outcome === "unreachable") {
			tally.unreachable += 1;
			console.log(`${address} #${round}  UNREACHABLE   ${result.code}  ${result.message}`);
			continue;
		}

		issuers.set(result.issuer, (issuers.get(result.issuer) ?? 0) + 1);
		if (result.outcome === "verified") {
			tally.verified += 1;
			const note = INTERCEPTOR.test(result.issuer) ? "  [intercepted, but trusted]" : "";
			console.log(`${address} #${round}  VERIFIED      issuer=${result.issuer}  ${result.protocol}${note}`);
		} else {
			tally.rejected += 1;
			const note = INTERCEPTOR.test(result.issuer) ? "  [interception]" : "";
			console.log(
				`${address} #${round}  NOT VERIFIED  issuer=${result.issuer}  ${result.protocol}  ${result.authorizationError ?? "unknown"}${note}`,
			);
		}
	}
}

console.log("");
console.log(`verified ${tally.verified}   rejected ${tally.rejected}   unreachable ${tally.unreachable}`);
if (issuers.size > 0) {
	console.log("issuers: " + [...issuers.entries()].map(([name, count]) => `${name} x${count}`).join(", "));
}

const interceptingIssuer = [...issuers.keys()].find((name) => INTERCEPTOR.test(name));
console.log("");

if (tally.rejected > 0) {
	console.log("VERDICT: a Node/Electron fetch on this host throws for these connections.");
	if (interceptingIssuer !== undefined) {
		console.log(`CAUSE: TLS is being decrypted locally by security software or a proxy ("${interceptingIssuer}").`);
		console.log("       The browser trusts that root because it lives in the OS store; Node/Electron does not.");
		console.log("FIX:   exclude this host from that product's encrypted-connection scanning,");
		console.log("       or export that root to PEM, point user env NODE_EXTRA_CA_CERTS at it, and restart the app fully.");
	} else {
		console.log("CAUSE: the chain does not verify against Node's bundled roots (clock skew, missing intermediate, stale CA bundle).");
		console.log("FIX:   check the system clock, update the app, then re-probe.");
	}
	process.exit(1);
}

if (tally.verified === 0) {
	console.log("VERDICT: nothing completed a handshake — reachability, not certificate trust.");
	console.log("         Check a required proxy, egress firewall, VPN, or provider outage before anything else.");
	process.exit(2);
}

if (interceptingIssuer !== undefined) {
	console.log(`VERDICT: TLS is decrypted by "${interceptingIssuer}", but every handshake verified.`);
} else {
	console.log("VERDICT: every handshake verified against a normal public chain.");
}
console.log("         Certificate trust is not the cause of a failure on this host.");
process.exit(0);
