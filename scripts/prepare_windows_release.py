import argparse, pathlib, urllib.request, hashlib, zipfile, shutil, json, subprocess
p=argparse.ArgumentParser();p.add_argument('edition',choices=['lite','cpu','opencl']);p.add_argument('--collect',action='store_true');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];tauri=root/'apps/desktop/src-tauri';runtime=tauri/'runtime/katago';bindir=runtime/'bin'
if not a.collect:
 if a.edition!='lite':
  kind,digest={'cpu':('eigen','d89c7cddc2c5543b6316d9094b7748cbc28ddddf8aa4dc4304a5b78032476221'),'opencl':('opencl','2224a32cb1cf9960d9b7caf9a53f049ccab7c7c822023171bd526fae120d7b54')}[a.edition]
  url=f'https://github.com/lightvector/KataGo/releases/download/v1.18.0/katago-v1.18.0-{kind}-windows-x64.zip'
  data=urllib.request.urlopen(url,timeout=90).read();assert hashlib.sha256(data).hexdigest()==digest
  archive=root/'katago-release.zip';archive.write_bytes(data);bindir.mkdir(parents=True,exist_ok=True)
  with zipfile.ZipFile(archive) as z:
   for info in z.infolist():
    rel=pathlib.PurePosixPath(info.filename)
    assert not rel.is_absolute() and '..' not in rel.parts
   z.extractall(bindir)
  engine=next(bindir.rglob('katago.exe'));assert engine.parent==bindir
  subprocess.run([str(engine),'version'],check=True,timeout=30)
  config=runtime/'configs';config.mkdir()
  (config/'analysis.cfg').write_text('numSearchThreads = 4\nnumAnalysisThreads = 1\nnnMaxBatchSize = 16\nreportAnalysisWinratesAs = BLACK\nlogToStderr = false\n')
  (runtime/'SOURCE.json').write_text(json.dumps({'url':url,'sha256':digest,'models_included':False},indent=2))
  conf=tauri/'tauri.conf.json';d=json.loads(conf.read_text());d['bundle']['resources']={'runtime/':'runtime/'};conf.write_text(json.dumps(d,indent=2))
else:
 out=root/'release-assets';out.mkdir(exist_ok=True);stem='lizze-remake-windows-x64-'+a.edition
 installers=list((root/'target/release/bundle/nsis').glob('*.exe'));assert len(installers)==1
 shutil.copy2(installers[0],out/(stem+'-setup.exe'))
