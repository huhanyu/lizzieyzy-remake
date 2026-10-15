#!/usr/bin/env python3
"""Install the local skill and project entry instructions; optionally a Git hook."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

NAME = 'project-doc-governance'
PACKAGE = Path(__file__).resolve().parents[1]
SOURCE = PACKAGE / 'skills' / NAME
BEGIN = '<!-- project-doc-governance:begin -->'
END = '<!-- project-doc-governance:end -->'
STAMP = '.docgov-installed.json'
HOOK_MARK = '# project-doc-governance managed hook v1'


def tree_hashes(path):
    result = {}
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            raise ValueError(f'Symlink cannot be replaced by installer: {file}')
        if file.is_file() and file.name != STAMP and '__pycache__' not in file.parts and file.suffix != '.pyc':
            result[file.relative_to(path).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def safe_target(root, path):
    for candidate in (path, *path.parents):
        if candidate == root:
            break
        if candidate.is_symlink():
            raise ValueError(f'Refuse managed write through symlink: {candidate}')


def preflight_skill(destination, wanted):
    safe_target(Path(destination.anchor), destination)
    if not destination.exists():
        return
    if not (destination / STAMP).is_file():
        raise ValueError(f'Existing unowned skill preserved: {destination}')
    previous = json.loads((destination / STAMP).read_text())['files']
    if tree_hashes(destination) not in (previous, wanted):
        raise ValueError(f'Locally edited skill preserved; merge manually: {destination}')


def install_skill(destination, wanted):
    if destination.exists() and tree_hashes(destination) == wanted:
        return 'unchanged'
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix='.docgov-', dir=destination.parent))
    staged = temp / NAME
    old = temp / 'previous'
    try:
        shutil.copytree(SOURCE, staged, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (staged / STAMP).write_text(json.dumps({'schema': 1, 'files': wanted}, indent=2) + '\n')
        if destination.exists():
            destination.rename(old)
        try:
            staged.rename(destination)
        except OSError:
            if old.exists():
                old.rename(destination)
            raise
    finally:
        shutil.rmtree(temp)
    return 'installed'


def instruction_block(package_relative):
    return f'''{BEGIN}
## 文档与决策维护

本项目采用 [文档治理工具包]({package_relative}/README.md)。当用户已授权在本项目开展维护时，首次进入或工具包更新后执行 `python3 {package_relative}/scripts/install.py --root . --git-hook`，验证本地 skill 和 Git 提交检查的部署；失败要报告，不能声称已生效。只读浏览或审计不要求安装。

文档审计、迁移或有长期取舍的改动，读取 [project-doc-governance]({package_relative}/skills/project-doc-governance/SKILL.md)。先检索相关决策，当前行为与理由各归其位，机械改动不新增 Note；提交前运行 `python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --managed`。检查通过仍需复核事实、例外和未验证事项。

练习项目的具体行为从相关模块文档下钻；不要把工具包示例当成其他模块的规则。
{END}'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--git-hook', action='store_true')
    parser.add_argument('--user-codex', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise ValueError('Project root must exist')
    try:
        package_relative = PACKAGE.relative_to(root).as_posix()
    except ValueError:
        raise ValueError('Copy this toolkit into the target project before running its installer')
    if any(c.isspace() for c in package_relative) or any(c in package_relative for c in "'\"`$;|&<>\\"):
        raise ValueError('Place toolkit at tools/doc-governance (relative path without shell metacharacters)')
    destinations = [root / '.agents' / 'skills' / NAME]
    if args.user_codex:
        destinations.append(Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'skills' / NAME)
    wanted = tree_hashes(SOURCE)
    for destination in destinations:
        preflight_skill(destination, wanted)
    agents = root / 'AGENTS.md'
    manifest = root / '.doc-governance.json'
    for path in (agents, manifest):
        safe_target(root, path)
    text = agents.read_text() if agents.exists() else '# 项目代理入口\n'
    block = instruction_block(package_relative)
    if BEGIN in text or END in text:
        if text.count(BEGIN) != 1 or text.count(END) != 1 or text.index(BEGIN) > text.index(END):
            raise ValueError('Malformed managed AGENTS block; preserved for review')
        text = text[:text.index(BEGIN)] + block + text[text.index(END) + len(END):]
    else:
        text = text.rstrip() + '\n\n' + block + '\n'
    hook = None
    hook_text = ''
    if args.git_hook:
        def run(*cmd):
            return subprocess.run(['git', '-C', str(root), *cmd], capture_output=True, text=True)
        check = run('rev-parse', '--show-toplevel')
        if check.returncode or Path(check.stdout.strip()).resolve() != root:
            raise ValueError('--git-hook requires the exact Git worktree root')
        configured = run('config', '--get', 'core.hooksPath')
        if configured.returncode == 0:
            raise ValueError('Existing core.hooksPath preserved; integrate checker into its existing hook manually')
        value = run('rev-parse', '--git-path', 'hooks/pre-commit')
        if value.returncode:
            raise ValueError(value.stderr.strip())
        hook = Path(value.stdout.strip())
        if not hook.is_absolute():
            hook = root / hook
        safe_target(Path(hook.anchor), hook)
        if hook.exists() and HOOK_MARK not in hook.read_text():
            raise ValueError('Existing pre-commit preserved; add the checker to that hook manually')
        hook_text = '''#!/bin/sh
# project-doc-governance managed hook v1
set -eu
docgov_root="$(git rev-parse --show-toplevel)"
exec python3 "$docgov_root/.agents/skills/project-doc-governance/scripts/check_docs.py" --root "$docgov_root" --staged
'''
        if hook.exists() and hook.read_text() != hook_text:
            raise ValueError('Edited managed hook preserved; merge manually')
    # Preflight every destination before the first mutation.
    results = {str(p): install_skill(p, wanted) for p in destinations}
    if not agents.exists() or agents.read_text() != text:
        agents.write_text(text)
    if not manifest.exists():
        manifest.write_text(json.dumps({'schema': 1, 'documents': ['AGENTS.md'],
                                       'document_roots': ['.agents/notes']}, indent=2) + '\n')
    if hook is not None:
        hook.parent.mkdir(parents=True, exist_ok=True)
        if not hook.exists() or hook.read_text() != hook_text:
            hook.write_text(hook_text)
        hook.chmod(0o755)
    print(json.dumps({'skills': results, 'instructions': str(agents),
                      'git_hook': str(hook) if hook else 'not requested',
                      'native_session_hooks': 'not installed'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        print(f'doc-governance install: {exc}', file=sys.stderr)
        sys.exit(2)
