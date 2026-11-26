#!/usr/bin/env node
/**
 * Summarize transport-level model-request failures in DSH Desktop host logs.
 * Bounded output: per-file counts plus the most recent occurrences.
 *
 * Usage: node find-transport-failures.mjs [--dir <logs-directory>] [--recent <count>]
 *
 * Exit codes:
 *   0  no transport failure found in the scanned logs
 *   1  at least one transport failure found
 *   2  the log directory could not be read
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function defaultLogDir() {
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "DSH Desktop", "logs", "host");
	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support", "DSH Desktop", "logs", "host");
	}
	return path.join(os.homedir(), ".config", "DSH Desktop", "logs", "host");
}

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const directory = argument("--dir", defaultLogDir());
const recent = Number(argument("--recent", "6"));
const FAILURE = /transport failed|\[TRANSPORT\]|\[TIMEOUT\]|\[EMPTY_RESPONSE\]|stream idle timeout|request aborted/i;

let entries;
try {
	entries = fs.readdirSync(directory, { withFileTypes: true });
} catch (error) {
	console.error(`cannot read ${directory}: ${error.code ?? error.message}`);
	console.error("pass --dir <logs-directory> when the app stores logs elsewhere");
	process.exit(2);
}

// The desktop writes `<date>.log` and `<date>.error.log` with overlapping content;
// one file per date keeps the totals honest.
const perDate = new Map();
for (const entry of entries) {
	if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
	const date = entry.name.replace(/\.error\.log$/, "").replace(/\.log$/, "");
	const current = perDate.get(date);
	if (current === undefined || (entry.name.endsWith(".error.log") && !current.endsWith(".error.log"))) {
		perDate.set(date, path.join(directory, entry.name));
	}
}
const files = [...perDate.values()].sort();

console.log(`logs: ${directory}`);
console.log(`dates: ${files.length}`);
console.log("");

let total = 0;
for (const file of files) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		continue;
	}
	const matches = text.split(/\r?\n/).filter((line) => FAILURE.test(line));
	if (matches.length === 0) continue;
	total += matches.length;
	console.log(`${path.basename(file)}: ${matches.length}`);
	for (const line of matches.slice(-recent)) {
		console.log(`  ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
	}
}

console.log("");
if (total === 0) {
	console.log("VERDICT: no transport failure recorded in these logs.");
	console.log("         Ask for the exact text and timestamp the user saw, or check another profile/log directory.");
	process.exit(0);
}

console.log(`VERDICT: ${total} transport failure line(s) across ${files.length} log file(s).`);
console.log("         The text alone names no cause; probe the endpoint next (tls-probe.mjs).");
process.exit(1);
