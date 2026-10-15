"""Bundled stdlib-only SSH supervisor. EOF/HUP closes only this task's engine group."""
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    import shutil
    engine, model, human, config, working = sys.argv[1:]
    if working:
        os.chdir(working)
    engine = shutil.which(engine) or engine
    version = subprocess.check_output([engine, "version"], timeout=30, stderr=subprocess.STDOUT).decode()
    identity = dict(engineVersion=version, engineSha256=digest(engine), modelSha256=digest(model),
                    humanModelSha256=digest(human), configSha256=digest(config),
                    cacheSafe="@include" not in open(config).read())
    child = None
    def stop(_signum, _frame):
        raise SystemExit(0)
    for name in ("SIGHUP", "SIGTERM", "SIGINT"):
        signal.signal(getattr(signal, name), stop)
    try:
        child = subprocess.Popen([engine, "analysis", "-model", model, "-human-model", human,
                                  "-config", config, "-override-config",
                                  "reportAnalysisWinratesAs=BLACK,numAnalysisThreads=1,nnMaxBatchSize=16,numSearchThreadsPerAnalysisThread=2"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
        print(json.dumps({"riskHandshake": identity, "enginePid": child.pid}), flush=True)
        selector = selectors.DefaultSelector()
        selector.register(sys.stdin.buffer, selectors.EVENT_READ, "input")
        selector.register(child.stdout, selectors.EVENT_READ, "output")
        buffer = b""
        closing = False
        while not closing:
            for key, _ in selector.select(timeout=1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    closing = True
                    break
                if key.data == "output":
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                else:
                    buffer += chunk
                    if len(buffer) > 16 * 1024 * 1024:
                        raise RuntimeError("query too large")
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        if json.loads(line).get("riskControl") == "close":
                            closing = True
                            break
                        child.stdin.write(line + b"\n")
                        child.stdin.flush()
            if child.poll() is not None:
                closing = True
    finally:
        if child is not None:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=2)
            try:
                print(json.dumps({"riskClosed": True, "exitCode": child.returncode}), flush=True)
            except (BrokenPipeError, OSError):
                pass


if __name__ == "__main__":
    main()
