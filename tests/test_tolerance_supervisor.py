"""Process-lifecycle tests use a synthetic engine, never a local KataGo model."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

WORKER = Path(__file__).resolve().parents[1] / 'apps/desktop/src-tauri/src/tolerance_review/ssh_worker.py'

@unittest.skipUnless(os.name == 'posix', 'POSIX SSH worker process groups')
class SupervisorLifecycle(unittest.TestCase):
    def run_close(self, control):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            engine=root/'fake-engine'
            engine.write_text('#!/usr/bin/env python3\nimport sys,time\nif "version" in sys.argv: print("test-engine");sys.exit(0)\nwhile True: time.sleep(.1)\n')
            engine.chmod(0o700)
            for name in ('model','human','config'): (root/name).write_text('test data')
            child=subprocess.Popen([sys.executable,str(WORKER),str(engine),'model','human','config',str(root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                import selectors
                selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
                self.assertTrue(selector.select(10),'handshake timeout')
                hello=json.loads(child.stdout.readline());engine_pid=hello['enginePid']
                stdout,stderr=child.communicate(input=control,timeout=10)
                self.assertEqual(child.returncode,0,stderr.decode())
                self.assertTrue(any(json.loads(line).get('riskClosed') is True for line in stdout.splitlines()))
                with self.assertRaises(ProcessLookupError): os.kill(engine_pid,0)
                selector.close()
            finally:
                if child.poll() is None: child.terminate();child.wait(timeout=5)
    def test_explicit_close_reaps_engine(self): self.run_close(b'{"riskControl":"close"}\n')
    def test_ssh_eof_reaps_engine(self): self.run_close(b'')

if __name__ == '__main__': unittest.main()
