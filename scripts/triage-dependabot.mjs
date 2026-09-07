#!/usr/bin/env node
/**
 * Triage Dependabot alerts.
 *
 * TubeSage ships a single tree-shaken main.js. Most alerts land on packages that
 * npm records in the lockfile but esbuild never bundles - optional dependencies of
 * @langchain/*, and the eslint toolchain. Those cannot reach a user's vault, so they
 * are dismissed as "not_used" rather than left to drown out a real one.
 *
 * The test is deliberately conservative: an alert is dismissed only when its package
 * is absent from the PRODUCTION dependency tree (npm ls --omit=dev). Anything present
 * there stays open for a human, even if it looks absent from the bundle. Dependabot
 * reopens a dismissed alert by itself if the package later becomes reachable.
 *
 * Env: GH_TOKEN (required), GITHUB_REPOSITORY (required), DRY_RUN=true to report only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';

const token = process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const dryRun = process.env.DRY_RUN === 'true';

if (!token || !repo) {
    console.error('GH_TOKEN and GITHUB_REPOSITORY must both be set.');
    process.exit(1);
}

const request = (url, init = {}) =>
    fetch(url, {
        ...init,
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
    });

const api = (path, init = {}) => request(`https://api.github.com/repos/${repo}${path}`, init);

/** Every package name reachable from the production dependency tree. */
function productionPackages() {
    let out = '';
    try {
        out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch (err) {
        // npm ls exits non-zero on peer/optional quirks but still prints the tree.
        out = err.stdout ?? '';
    }
    const marker = '/node_modules/';
    const names = new Set();
    for (const line of out.split('\n')) {
        const i = line.lastIndexOf(marker);
        if (i !== -1) names.add(line.slice(i + marker.length));
    }
    if (names.size === 0) throw new Error('npm ls produced no production packages - refusing to dismiss anything.');
    return names;
}

// The Dependabot alerts endpoint uses cursor pagination (before/after), not page
// numbers, so follow the Link header rather than incrementing a counter.
async function openAlerts() {
    const alerts = [];
    let url = `https://api.github.com/repos/${repo}/dependabot/alerts?state=open&per_page=100`;
    while (url) {
        const res = await request(url);
        if (res.status === 403) {
            console.error(
                'HTTP 403 reading Dependabot alerts.\n' +
                'The token cannot access security alerts. Add a fine-grained PAT with\n' +
                '"Dependabot alerts: read and write" as the DEPENDABOT_TRIAGE_TOKEN secret.'
            );
            process.exit(1);
        }
        if (!res.ok) throw new Error(`GET alerts failed: ${res.status} ${await res.text()}`);
        alerts.push(...(await res.json()));
        url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    return alerts;
}

const prod = productionPackages();
const bundle = existsSync('main.js') ? readFileSync('main.js', 'utf8') : null;
const alerts = await openAlerts();

const dismiss = [];
const keep = [];
for (const alert of alerts) {
    const name = alert.dependency.package.name;
    (prod.has(name) ? keep : dismiss).push({ number: alert.number, name, alert });
}

let dismissed = 0;
let failed = 0;
for (const { number, name } of dismiss) {
    if (dryRun) continue;
    const res = await api(`/dependabot/alerts/${number}`, {
        method: 'PATCH',
        body: JSON.stringify({
            state: 'dismissed',
            dismissed_reason: 'not_used',
            dismissed_comment:
                `${name} is absent from TubeSage's production dependency tree, so it is not ` +
                'part of the bundled plugin and no vulnerable code reaches users. ' +
                'Dismissed automatically by .github/workflows/dependabot-triage.yml.',
        }),
    });
    if (res.status === 403) {
        console.error(
            `HTTP 403 dismissing alert #${number}.\n` +
            'The token lacks write access to Dependabot alerts. The built-in GITHUB_TOKEN may\n' +
            'not be sufficient; add a fine-grained PAT with "Dependabot alerts: read and write"\n' +
            'as the DEPENDABOT_TRIAGE_TOKEN repository secret.'
        );
        process.exit(1);
    }
    if (res.ok) dismissed++;
    else {
        failed++;
        console.error(`  ! #${number} ${name}: ${res.status} ${await res.text()}`);
    }
}

const bundleNote = (name) =>
    bundle === null ? '' : bundle.includes(`node_modules/${name}/`) ? ' [in bundle]' : ' [not in bundle]';

const lines = [
    `# Dependabot triage${dryRun ? ' (dry run)' : ''}`,
    '',
    `Open alerts examined: **${alerts.length}**`,
    `Dismissed as \`not_used\`: **${dryRun ? `${dismiss.length} would be` : dismissed}**${failed ? ` (${failed} failed)` : ''}`,
    `Left open for review: **${keep.length}**`,
    '',
];
if (keep.length) {
    lines.push('## Needs attention - these ship to users', '');
    for (const { number, name } of keep) lines.push(`- #${number} \`${name}\`${bundleNote(name)}`);
    lines.push('');
}
if (dismiss.length) {
    lines.push(`## ${dryRun ? 'Would dismiss' : 'Dismissed'} - not in the production tree`, '');
    for (const { number, name } of dismiss) lines.push(`- #${number} \`${name}\`${bundleNote(name)}`);
}

const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

process.exit(failed ? 1 : 0);
