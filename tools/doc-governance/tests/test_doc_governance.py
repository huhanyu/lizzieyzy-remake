"""Behavior checks in disposable projects; never commit in the user's repository."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
SCRIPT = PACKAGE / 'skills/project-doc-governance/scripts/check_docs.py'
SPEC = importlib.util.spec_from_file_location('check_docs', SCRIPT)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)
NOTE = '''# Agent Note: Keep the file format explicit

Status: implemented

## Problem
Readers need a stable key.

## Decision
The key is named id.

## Alternatives considered
Historical alternatives are not recorded; this is a retrospective record.

## Consequences
Renaming the key requires migrating consumers.
'''
NOTE_PATH = '.agents/notes/implemented/architecture/2026-10-04-explicit-key.md'


class DocumentationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='docgov test ')
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def put(self, name, text):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def git(self, *args, expected=0):
        result = subprocess.run(['git', '-C', str(self.root), *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def init_git(self):
        self.git('init', '-q')
        self.git('config', 'user.name', 'Doc Governance Test')
        self.git('config', 'user.email', 'docgov@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        # Avoid inheriting a developer's global hook path in disposable fixtures.
        self.git('config', '--local', 'core.hooksPath', '.git/hooks')
        self.git('config', '--local', '--unset', 'core.hooksPath')

    def audit(self, *paths, staged=False):
        return checker.check(checker.Snapshot(self.root, staged), list(paths))['findings']

    def install(self, *options, expected=0):
        result = subprocess.run([sys.executable, str(self.root / 'tools/doc-governance/scripts/install.py'),
                                 '--root', str(self.root), *options], capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def copy_package(self):
        shutil.copytree(PACKAGE, self.root / 'tools/doc-governance',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))

    def test_links_skip_examples_but_check_real_targets(self):
        self.put('docs/exists space.md', '# Target')
        self.put('docs/source.md', '[ok](exists%20space.md)\n[reference][id]\n[id]: <exists space.md>\n'
                 '```md\n[example](missing.md)\n```\n`[inline](missing.md)`\n[bad](absent.md)\n')
        issues = self.audit('docs/source.md')
        self.assertEqual([x['rule'] for x in issues], ['local-link'])
        self.assertIn('absent.md', issues[0]['detail'])

    def test_note_accepts_truthful_unknown_alternatives(self):
        self.put(NOTE_PATH, NOTE)
        self.assertEqual(self.audit(NOTE_PATH), [])

    def test_empty_alternatives_is_not_satisfied_by_heading(self):
        self.put(NOTE_PATH, NOTE.replace('Historical alternatives are not recorded; this is a retrospective record.', '<!-- fill later -->'))
        self.assertIn('empty-section', [x['rule'] for x in self.audit(NOTE_PATH)])

    def test_lifecycle_mismatch_and_proposal_heading_fail(self):
        self.put(NOTE_PATH, NOTE.replace('Status: implemented', 'Status: proposed') + '\n## Plan\nDo it next week.\n')
        self.assertEqual({x['rule'] for x in self.audit(NOTE_PATH)}, {'note-header', 'implemented-plan'})

    def test_fenced_heading_does_not_fill_required_section(self):
        self.put(NOTE_PATH, NOTE.replace('## Alternatives considered', '```md\n## Alternatives considered\n```'))
        self.assertIn('note-section', [x['rule'] for x in self.audit(NOTE_PATH)])

    def test_anchor_and_html_are_review_not_claimed_pass(self):
        self.put('doc.md', '# Title\n[local](#other)\n<a href="other.md">Other</a>\n')
        issues = self.audit('doc.md')
        self.assertEqual({x['rule'] for x in issues}, {'anchor', 'advanced-markup'})
        self.assertTrue(all(x['level'] == 'review' for x in issues))

    def test_multiple_links_on_one_line_are_not_complex_markup(self):
        self.put('a.md', '# A')
        self.put('b.md', '# B')
        self.put('doc.md', '[a](a.md) and [b](b.md)\n')
        self.assertEqual(self.audit('doc.md'), [])

    def test_note_subtree_instructions_are_not_decision_records(self):
        self.put('.agents/notes/implemented/AGENTS.md', '# Instructions\nRead the owning note.\n')
        self.assertEqual(self.audit('.agents/notes/implemented/AGENTS.md'), [])

    def test_index_not_worktree_is_checked(self):
        self.init_git()
        self.put('doc.md', '[bad](absent.md)\n')
        self.git('add', 'doc.md')
        self.put('doc.md', '# Fixed only in working tree\n')
        self.assertEqual(self.audit('doc.md'), [])
        self.assertIn('local-link', [x['rule'] for x in self.audit('doc.md', staged=True)])

    def test_index_target_deletion_breaks_existing_inbound_link(self):
        self.init_git()
        self.put('doc.md', '[target](target.md)\n')
        self.put('target.md', '# Target\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')
        self.git('rm', 'target.md')
        self.put('target.md', '# Unstaged replacement must not hide deletion\n')
        self.assertIn('local-link', [x['rule'] for x in self.audit('doc.md', staged=True)])

    def test_committed_archive_cannot_be_changed_or_deleted(self):
        self.init_git()
        p = '.agents/notes/archived/architecture/2026-01-01-old.md'
        self.put(p, '# Frozen historical format\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'archive fixture')
        self.put(p, '# Updated\n')
        self.git('add', p)
        self.assertIn('frozen-archive', [x['rule'] for x in self.audit(p, staged=True)])
        self.git('rm', '-f', p)
        self.assertIn('frozen-archive', [x['rule'] for x in self.audit(staged=True)])

    def test_installer_idempotence_and_user_edit_protection(self):
        self.copy_package()
        self.put('AGENTS.md', '# Original rules\nKeep user rules.\n')
        self.install()
        before = (self.root / 'AGENTS.md').read_bytes()
        result = self.install()
        self.assertIn('unchanged', result.stdout)
        self.assertEqual(before, (self.root / 'AGENTS.md').read_bytes())
        self.assertIn('Keep user rules.', before.decode())
        p = self.root / '.agents/skills/project-doc-governance/SKILL.md'
        p.write_text(p.read_text() + '\nLocal customization.\n')
        self.install(expected=2)
        self.assertIn('Local customization.', p.read_text())

    def test_existing_hook_causes_no_partial_install(self):
        self.init_git()
        self.copy_package()
        hook = self.put('.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n')
        self.install('--git-hook', expected=2)
        self.assertEqual(hook.read_text(), '#!/bin/sh\nexit 0\n')
        self.assertFalse((self.root / '.agents/skills/project-doc-governance').exists())
        self.assertFalse((self.root / 'AGENTS.md').exists())

    def test_real_git_hook_rejects_bad_staged_doc_and_accepts_repair(self):
        self.init_git()
        self.copy_package()
        self.install('--git-hook')
        self.put('.doc-governance.json', json.dumps({'documents': ['doc.md']}))
        self.put('doc.md', '[broken](missing.md)\n')
        self.git('add', '.')
        result = self.git('commit', '-qm', 'reject bad doc', expected=1)
        self.assertIn('local-link', result.stdout + result.stderr)
        self.put('doc.md', '# Fixed\n')
        self.git('add', 'doc.md')
        self.git('commit', '-qm', 'accept fixed doc')
        self.install('--git-hook')

    def test_inventory_ignores_build_and_symlink_paths(self):
        self.put('docs/good.md', '# Good')
        self.put('target/build.md', '# Build')
        (self.root / 'linked').symlink_to(self.root / 'docs', target_is_directory=True)
        self.assertEqual(checker.Snapshot(self.root).documents(), ['docs/good.md'])


if __name__ == '__main__':
    unittest.main()
