import json,subprocess,time,pathlib
out=pathlib.Path(__file__).resolve().parent
config=out/'analysis.cfg'
config.write_text('numAnalysisThreads = 1\nnumSearchThreads = 1\nnnMaxBatchSize = 4\nreportAnalysisWinratesAs = BLACK\nlogAllRequests = false\nlogAllResponses = false\n')
exe='/opt/homebrew/bin/katago';model='/Users/ice/.lizzieyzy-dev/models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz'
games=[('a','(;GM[1]FF[4]SZ[9]KM[7.5]RU[Chinese];B[cc];W[gg];B[cg])',[['B','C7'],['W','G3'],['B','C3']]),('b','(;GM[1]FF[4]SZ[9]KM[6.5]RU[Japanese];B[ee];W[ec];B[ce])',[['B','E5'],['W','E7'],['B','C5']])]
results=[]
for name,sgf,moves in games:
    (out/f'{name}.sgf').write_text(sgf)
    query={'id':f'p2-queue-{name}','moves':moves,'rules':'chinese' if name=='a' else 'japanese','komi':7.5 if name=='a' else 6.5,'boardXSize':9,'boardYSize':9,'analyzeTurns':[0,1,2,3],'maxVisits':8,'includeOwnership':True,'includePolicy':True}
    (out/f'{name}.request.jsonl').write_text(json.dumps(query)+'\n')
    t=time.monotonic()
    p=subprocess.run([exe,'analysis','-model',model,'-config',str(config)],input=json.dumps(query)+'\n',text=True,capture_output=True,timeout=150,cwd='/tmp')
    (out/f'{name}.stdout.jsonl').write_text(p.stdout)
    (out/f'{name}.stderr.txt').write_text(p.stderr)
    rows=[json.loads(line) for line in p.stdout.splitlines() if line.startswith('{')]
    good=[r for r in rows if r.get('id')==query['id'] and 'rootInfo' in r]
    assert p.returncode==0,(p.returncode,p.stderr[-1000:])
    assert sorted(r['turnNumber'] for r in good)==[0,1,2,3],rows
    assert all(len(r.get('ownership',[]))==81 and len(r.get('policy',[]))==82 and r['rootInfo']['visits']>=8 for r in good)
    assert all(0<=r['rootInfo']['winrate']<=1 for r in good)
    results.append({'name':name,'id':query['id'],'returncode':p.returncode,'turns':sorted(r['turnNumber'] for r in good),'ownership':81,'policy':82,'seconds':round(time.monotonic()-t,2),'minimumVisits':min(r['rootInfo']['visits'] for r in good)})
    print(json.dumps(results[-1]),flush=True)
(out/'summary.json').write_text(json.dumps({'engine':'KataGo v1.18.2 Metal','model':model,'independentSequentialProcesses':True,'results':results},indent=2))
