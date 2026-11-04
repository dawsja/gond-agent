#!/usr/bin/env python3
"""Offline localisation proxy, not model turns/tokens-before-edit.

Run: python3 scripts/repo-map-benchmark.py
Requires git, Universal Ctags, Cargo and already-cached locked Rust dependencies.
Never fetches history/dependencies. Needs >=40 non-merge source-changing commits;
if the checkout is shallow, deepen it separately first. No identity/commits needed.

Select commits changing source; each subject is a task, but ground truth is ALL
changed paths, including docs, lockfiles, new and deleted files. Evaluate the
parent tree (no future code/task leakage).
Map: actual shipped implementation, default 2000 tokens, no focus/task keywords.
Baseline: first six distinct lowercase subject words of >=4 letters, excluding
STOP below. One git-ls-files path substring query for all keywords (100 paths),
then one case-insensitive literal git-grep per keyword (100 matching lines each,
30,000 bytes per call). Fixed keyword order, no semantic search, no peeking at
truth to choose queries. Stop effort accounting after the first result page
containing a truth file; also execute all pages for recall in the first 8000
output bytes (2000 estimated tokens). Both methods count full result-page tokens
until first success; misses are NA, never zero. Token estimate = ceil(bytes/4).
This is a deliberately specified baseline, not a claim about optimal search.
A live A/B needs identical tasks/base trees, model/settings, randomised order,
equal context/tool limits and instrumentation of actual turns/tokens to edit.
"""
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.py', '.go', '.css'}
STOP = set('with from that this into when then than have make more only keep using used add fix for the and not without before after'.split())
ENV = {k: v for k, v in os.environ.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN') and not k.startswith('GOND_AGENT_')}
ENV.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', LC_ALL='C', CARGO_NET_OFFLINE='true')


def git(*args, cwd=ROOT, allow_empty=False):
    p = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=cwd,
                       env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if p.returncode and not (allow_empty and p.returncode == 1):
        raise RuntimeError('git operation failed: ' + args[0])
    return p.stdout


def tokens(data):
    return math.ceil(len(data) / 4)


def paths_from_map(out):
    return [line for line in out.splitlines()[2:] if line and not line.startswith(' ')]


def baseline(root, subject, truth):
    keywords = list(dict.fromkeys(w for w in re.findall('[a-z]+', subject.lower()) if len(w) >= 4 and w not in STOP))[:6]
    paths = sorted(os.fsdecode(p) for p in git('ls-files', '-z', cwd=root).split(b'\0') if p)
    matches = [p for p in paths if any(k in p.lower() for k in keywords)][:100]
    pages = [('\n'.join(matches) + '\n').encode() if matches else b'No matches\n']
    page_paths = [matches]
    for keyword in keywords:
        rows = git('grep', '-n', '-I', '-i', '-F', '-e', keyword, '--', cwd=root, allow_empty=True).splitlines()[:100]
        page = b'\n'.join(rows)[:30000] or b'No matches'
        pages.append(page + b'\n')
        page_paths.append([os.fsdecode(row.split(b':', 1)[0]) for row in page.splitlines() if b':' in row])
    used, first_calls, first_tokens = 0, None, None
    budget_output = b''
    for i, (page, files) in enumerate(zip(pages, page_paths), 1):
        used += tokens(page)
        if first_calls is None and truth.intersection(files):
            first_calls, first_tokens = i, used
        budget_output += page
    recall_files = set()
    for row in budget_output[:8000].decode('utf-8', 'replace').splitlines():
        path = row.split(':', 1)[0]
        if path in truth:
            recall_files.add(path)
    return len(recall_files), first_calls, first_tokens, keywords


def main():
    tasks = []
    for line in git('log', '--no-merges', '--format=%H%x09%s').decode().splitlines():
        sha, subject = line.split('\t', 1)
        changed = {os.fsdecode(p) for p in git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha).split(b'\0') if p}
        parents = git('rev-list', '--parents', '-n', '1', sha).decode().split()
        if any(Path(p).suffix in SOURCE for p in changed) and len(parents) > 1:
            tasks.append((sha, parents[1], subject, changed))
        if len(tasks) == 40:
            break
    if len(tasks) < 40:
        raise SystemExit(f'Need 40 eligible commits with parents; found {len(tasks)}. Deepen history separately.')
    with tempfile.TemporaryDirectory(prefix='gond-map-benchmark-') as scratch:
        temp = Path(scratch)
        roots = []
        objects = Path(git('rev-parse', '--git-path', 'objects').decode().strip()).resolve()
        for i, (_, parent, _, _) in enumerate(tasks):
            root = temp / str(i)
            root.mkdir()
            archive = temp / 'tree.tar'
            archive.write_bytes(git('archive', '--format=tar', parent))
            with tarfile.open(archive) as tar:
                tar.extractall(root, filter='data')
            git('init', '--quiet', '--template=', cwd=root)
            (root / '.git/objects/info/alternates').write_text(str(objects) + '\n')
            (root / '.git/HEAD').write_text(parent + '\n')
            git('read-tree', parent, cwd=root)
            roots.append(str(root))
        manifest, result = temp / 'input.json', temp / 'output.json'
        manifest.write_text(json.dumps(roots))
        run_env = dict(ENV, REPO_MAP_BENCH_INPUT=str(manifest), REPO_MAP_BENCH_OUTPUT=str(result))
        subprocess.run(['cargo', 'test', '--offline', '--locked', 'repo_map::tests::history_proxy_maps', '--', '--ignored', '--nocapture', '--test-threads=1'],
                       cwd=ROOT / 'runner', env=run_env, check=True, stdout=subprocess.PIPE, timeout=180)
        maps = json.loads(result.read_text())
        print('Localisation proxy: last 40 non-merge source-changing commits, evaluated on parent trees.')
        print('Map=2000 tokens, unfocused; baseline=path query then <=6 literal greps, 100 rows/call, 30000 bytes/call.')
        print('Truth=all changed paths (including docs/locks); recall budget=8000 bytes; tokens=ceil(bytes/4); effort counts full pages; NA=not surfaced. New files count as misses.')
        print('commit | map hits/truth | first rank | map tokens | baseline hits/truth | calls/tokens to first | subject')
        total, map_hits, base_hits, absent = 0, 0, 0, 0
        map_calls, map_costs, base_calls, base_costs = [], [], [], []
        for (sha, _, subject, truth), root, out in zip(tasks, roots, maps):
            ranked = paths_from_map(out)
            hits = len(truth.intersection(ranked))
            first = next((i for i, p in enumerate(ranked, 1) if p in truth), None)
            cost = tokens(out.encode())
            b_hits, b_calls, b_cost, _ = baseline(root, subject, truth)
            total += len(truth); map_hits += hits; base_hits += b_hits
            absent += sum(not (Path(root) / p).exists() for p in truth)
            if first is not None:
                map_calls.append(1); map_costs.append(cost)
            if b_calls is not None:
                base_calls.append(b_calls); base_costs.append(b_cost)
            print(f'{sha[:8]} | {hits}/{len(truth)} | {first or "NA"} | {cost} | {b_hits}/{len(truth)} | {b_calls or "NA"}/{b_cost if b_cost is not None else "NA"} | {subject}')
        print(f'Micro recall@2000: map {map_hits}/{total}={map_hits/total:.2%}; baseline {base_hits}/{total}={base_hits/total:.2%}.')
        print(f'Changed paths absent in parent: {absent}/{total}.')
        for label, calls, costs in [('map', map_calls, map_costs), ('baseline', base_calls, base_costs)]:
            print(f'{label}: surfaced {len(calls)}/40 tasks; misses {40-len(calls)}/40; conditional median calls={statistics.median(calls) if calls else "NA"}, tokens={statistics.median(costs) if costs else "NA"}.')
            print(f'  arithmetic: calls sorted={sorted(calls)}; tokens sorted={sorted(costs)}; median=middle value (or mean of two middle values).')
        print('Proxy only: no model turns or tokens-before-first-edit measured. Fake-model harnesses replay prescribed calls, not autonomous localisation decisions.')


if __name__ == '__main__':
    main()
