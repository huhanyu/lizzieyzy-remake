"""Bundle the installed Apple Silicon KataGo and its non-system dylibs, without models."""
import argparse, hashlib, json, pathlib, shutil, subprocess
p=argparse.ArgumentParser();p.add_argument('--app',required=True);p.add_argument('--engine',default='/opt/homebrew/bin/katago');a=p.parse_args()
root=pathlib.Path(a.app)/'Contents/Resources/runtime/katago';dest=root/'bin';dest.mkdir(parents=True,exist_ok=True)
seen={};todo=[pathlib.Path(a.engine).resolve()]
while todo:
 src=todo.pop().resolve()
 if src in seen:continue
 deps=[]
 for line in subprocess.check_output(['otool','-L',str(src)],text=True).splitlines()[1:]:
  dep=line.strip().split(' (')[0]
  if dep.startswith('/opt/homebrew/'):
   target=pathlib.Path(dep).resolve();deps.append((dep,target));todo.append(target)
 seen[src]=deps
for src in seen:shutil.copy2(src,dest/src.name)
for src,deps in seen.items():
 target=dest/src.name;target.chmod(0o755)
 for old,dep in deps:subprocess.run(['install_name_tool','-change',old,'@loader_path/'+dep.name,str(target)],check=True,capture_output=True)
 if src.suffix=='.dylib':subprocess.run(['install_name_tool','-id','@loader_path/'+src.name,str(target)],check=True,capture_output=True)
 subprocess.run(['codesign','--force','--sign','-',str(target)],check=True,capture_output=True)
# Copy dependency licenses from the exact installed formulas.
licenses=root/'licenses';licenses.mkdir(exist_ok=True)
for src in seen:
 parts=src.parts
 if 'Cellar' not in parts:continue
 i=parts.index('Cellar');formula=pathlib.Path(*parts[:i+3]);out=licenses/parts[i+1];out.mkdir(exist_ok=True)
 for f in formula.rglob('*'):
  if f.is_file() and (f.name.upper().startswith(('LICENSE','COPYING','COPYRIGHT','NOTICE'))):
   rel=f.relative_to(formula);t=out/rel;t.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,t)
configs=root/'configs';configs.mkdir(exist_ok=True)
(configs/'analysis.cfg').write_text('numSearchThreads = 4\nnumAnalysisThreads = 1\nnnMaxBatchSize = 16\nreportAnalysisWinratesAs = BLACK\nlogToStderr = false\n')
(root/'manifest.json').write_text(json.dumps({'engine':subprocess.check_output([str(dest/'katago'),'version'],text=True).strip(),'models_included':False,'files':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in dest.iterdir()}},indent=2))
for f in dest.iterdir():
 output=subprocess.check_output(['otool','-L',str(f)],text=True)
 assert '/opt/homebrew/' not in output, str(f)
subprocess.run(['codesign','--force','--deep','--sign','-',a.app],check=True)
print('Bundled and verified:',root)
