#!/usr/bin/env python3
"""Read-only scoped Markdown checks; no semantic validation or document mutation."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

IGNORED = {'.git', 'target', 'node_modules', 'dist', 'build', 'vendor', '.venv', '__pycache__'}
REQUIRED = {
    'proposed': {'Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'},
    'implemented': {'Problem', 'Decision', 'Alternatives considered', 'Consequences'},
    'rejected': {'Problem', 'Proposal', 'Alternatives considered'},
}


def git(root, *args, required=True):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True)
    if required and result.returncode:
        raise ValueError(result.stderr.decode(errors='replace').strip())
    return result


def relative(value):
    p = PurePosixPath(value)
    if p.is_absolute() or '..' in p.parts or not p.parts or '\\' in value:
        raise ValueError(f'Expected project-relative path: {value}')
    return p.as_posix()


def prose(text):
    """Remove fenced/inline examples so example headings and links are not checked."""
    lines = []
    fence = None
    for line in text.splitlines():
        m = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if fence:
            if m and m[1][0] == fence[0] and len(m[1]) >= len(fence):
                fence = None
            continue
        if m:
            fence = m[1]
            continue
        lines.append(re.sub(r'(`+).*?\1', '', line))
    return '\n'.join(lines)


def link_urls(text):
    # Deliberately bounded Markdown subset. Advanced markup needs site validation.
    pattern = r'!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s()]+)(?:\s+"[^"\n]*")?\s*\)|^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)'
    for m in re.finditer(pattern, prose(text), re.M):
        yield (m[1] or m[2]).strip('<>')


class Snapshot:
    def __init__(self, root, staged=False):
        self.root = root.resolve()
        self.staged = staged
        self.files = None
        self.symlinks = set()
        if staged:
            entries = git(root, 'ls-files', '--stage', '-z').stdout.decode().split('\0')
            self.files = set()
            for entry in filter(None, entries):
                metadata, path = entry.split('\t', 1)
                mode, _oid, stage = metadata.split()
                if stage != '0':
                    raise ValueError('Resolve Git index conflicts before checking documents')
                self.files.add(path)
                if mode == '120000':
                    self.symlinks.add(path)

    def path(self, rel):
        p = self.root / relative(rel)
        if not p.resolve().is_relative_to(self.root):
            raise ValueError(f'External symlink is not inspected: {rel}')
        return p

    def read(self, rel):
        rel = relative(rel)
        if self.staged:
            if rel in self.symlinks:
                raise ValueError(f'Staged symlink content needs separate review: {rel}')
            return git(self.root, 'show', ':' + rel).stdout.decode('utf-8')
        return self.path(rel).read_text(encoding='utf-8')

    def exists(self, rel):
        rel = relative(rel)
        if self.staged:
            return rel in self.files or any(p.startswith(rel.rstrip('/') + '/') for p in self.files)
        return self.path(rel).exists()

    def documents(self):
        if self.staged:
            return sorted(p for p in self.files if p.endswith('.md') and p not in self.symlinks)
        paths = []
        for base, dirs, names in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in IGNORED and not Path(base, d).is_symlink())
            paths.extend(Path(base, n).relative_to(self.root).as_posix() for n in names
                         if n.endswith('.md') and not Path(base, n).is_symlink())
        return sorted(paths)

    def managed(self):
        if not self.exists('.doc-governance.json'):
            if self.staged:
                return []
            raise ValueError('Missing .doc-governance.json; use --files for explicit scope')
        config = json.loads(self.read('.doc-governance.json'))
        documents = {relative(x) for x in config.get('documents', [])}
        roots = [relative(x).rstrip('/') + '/' for x in config.get('document_roots', [])]
        documents.update(p for p in self.documents() if any(p.startswith(r) for r in roots))
        return sorted(documents)


def check(snapshot, paths):
    findings = []
    def add(level, rule, path, detail):
        findings.append(dict(level=level, rule=rule, path=path, detail=detail))
    for path in sorted(set(paths)):
        if not snapshot.exists(path):
            add('error', 'missing-document', path, 'Document not present in selected snapshot')
            continue
        text = snapshot.read(path)
        if path.startswith('.agents/notes/archived/'):
            continue  # Frozen history is not rewritten to modern format or current links.
        body = prose(text)
        for url in link_urls(text):
            parsed = urlsplit(url)
            if parsed.scheme or parsed.netloc:
                continue
            if parsed.fragment:
                add('review', 'anchor', path, f'Anchor needs renderer/semantic review: {url}')
            if not parsed.path:
                continue
            if parsed.path.startswith('/'):
                add('review', 'site-root-link', path, f'Published site base needed: {url}')
                continue
            dest = os.path.normpath(str(PurePosixPath(path).parent / unquote(parsed.path))).replace(os.sep, '/')
            try:
                exists = snapshot.exists(dest)
            except ValueError:
                exists = False
            if not exists:
                add('error', 'local-link', path, f'Missing or out-of-scope target: {url}')
        if re.search(r'<(?:a|img)\b|\[\[', body, re.I) or re.search(r'\]\(\s*[^<\s()]*\(', body):
            add('review', 'advanced-markup', path, 'HTML, wiki or nested-parenthesis links require owning renderer checks')
        m = re.match(r'^\.agents/notes/(proposed|implemented|rejected)/.+\.md$', path)
        if not m or PurePosixPath(path).name in {'AGENTS.md', 'README.md'}:
            continue
        lifecycle = m[1]
        first = text.splitlines()
        status = r'Status: ' + lifecycle + (r' — .+' if lifecycle == 'rejected' else '')
        if len(first) < 4 or not first[0].startswith('# Agent Note: ') or first[1] or not re.fullmatch(status, first[2]) or first[3]:
            add('error', 'note-header', path, 'Expected title, blank, lifecycle Status line, blank')
        try:
            datetime.date.fromisoformat(PurePosixPath(path).name[:10])
        except ValueError:
            add('error', 'note-date', path, 'Filename must begin with a valid YYYY-MM-DD date')
        headings = re.findall(r'^## (.+?)\s*$', body, re.M)
        if not headings or headings[0] != 'Problem':
            add('error', 'note-opener', path, 'First section must be Problem')
        for name in sorted(REQUIRED[lifecycle] - set(headings)):
            add('error', 'note-section', path, f'Missing {name}')
        if lifecycle == 'implemented':
            for name in {'Proposal', 'Plan', 'Migration plan', 'Acceptance criteria'} & set(headings):
                add('error', 'implemented-plan', path, f'Proposal-era heading: {name}')
        for part in re.split(r'^## ', body, flags=re.M)[1:]:
            name, _, contents = part.partition('\n')
            if name.strip() in REQUIRED[lifecycle] and not re.sub(r'<!--.*?-->', '', contents, flags=re.S).strip():
                add('error', 'empty-section', path, f'Empty {name.strip()}')
    if snapshot.staged:
        archive = '.agents/notes/archived/'
        changes = git(snapshot.root, 'diff', '--cached', '--name-only', '-z', '--', archive).stdout.decode().split('\0')
        for path in filter(None, changes):
            before = git(snapshot.root, 'show', 'HEAD:' + path, required=False)
            if before.returncode == 0:
                after = git(snapshot.root, 'show', ':' + path, required=False)
                if after.returncode or before.stdout != after.stdout:
                    add('error', 'frozen-archive', path, 'Committed archived file changed or disappeared')
    return {'mode': 'git-index' if snapshot.staged else 'working-tree', 'checked': len(set(paths)),
            'findings': findings, 'semantic_review': 'required; structural success is not a full audit'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--files', nargs='+')
    modes.add_argument('--managed', action='store_true')
    modes.add_argument('--staged', action='store_true')
    modes.add_argument('--inventory', action='store_true')
    args = parser.parse_args()
    snapshot = Snapshot(args.root, args.staged)
    if args.inventory:
        result = {'documents': [{'path': p, 'sha256': hashlib.sha256(snapshot.path(p).read_bytes()).hexdigest()}
                                for p in snapshot.documents()]}
    else:
        paths = [relative(p) for p in args.files] if args.files else snapshot.managed()
        result = check(snapshot, paths)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(f['level'] == 'error' for f in result.get('findings', [])) else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, UnicodeError) as exc:
        print(f'doc-governance: {exc}', file=sys.stderr)
        sys.exit(2)
