import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_GAME_INFO,newGameSgf,handicapPoints,serializeTree,insertMove,swapColors,flattenPosition} from '../src/domain/documentEditing.ts';
import {DocumentHistory,addRecentDocument} from '../src/domain/documentHistory.ts';
const n=(id,parent,children,properties)=>({id,parent_id:parent,child_ids:children,properties});
const p=(key,...values)=>({key,values});
const tree={root_id:'r',nodes:[n('r',null,['a'],[p('SZ','9'),p('KM','7.5'),p('PB','Black'),p('PW','White'),p('C','a]b\\c')]),n('a','r',['b','c'],[p('B','aa')]),n('b','a',[],[p('W','bb'),p('XX','custom')]),n('c','a',[],[p('W','cc')])]};
test('serializes unknown properties, escapes and all siblings without loss',()=>{
 assert.equal(serializeTree(tree),'(;SZ[9]KM[7.5]PB[Black]PW[White]C[a\\]b\\\\c];B[aa](;W[bb]XX[custom])(;W[cc]))');
});
test('insertion only changes selected variation linkage',()=>{
 const text=insertMove(tree,'b','black',{x:3,y:3},9);
 assert.ok(text.includes('(;B[dd];W[bb]XX[custom])(;W[cc])'));
 assert.throws(()=>insertMove(tree,'r','black','pass',9));
 assert.throws(()=>insertMove(tree,'b','black',{x:9,y:3},9));
});
test('new game validates sizes/komi and produces unique handicap locations',()=>{
 for(let count=2;count<=9;count++){const points=handicapPoints(19,count);assert.equal(points.length,count);assert.equal(new Set(points.map(p=>JSON.stringify(p))).size,count);}
 assert.ok(newGameSgf({...DEFAULT_GAME_INFO,handicap:9}).includes('HA[9]AB['));
 assert.ok(newGameSgf({...DEFAULT_GAME_INFO,handicap:9}).includes('PL[W]'));
 assert.throws(()=>newGameSgf({...DEFAULT_GAME_INFO,size:10,handicap:2}));
 assert.throws(()=>newGameSgf({...DEFAULT_GAME_INFO,komi:Infinity}));
});
test('color exchange is involutive on non-handicap properties including names and komi',()=>{
 const text=swapColors(tree);assert.ok(text.includes('KM[-7.5]PW[Black]PB[White]'));assert.ok(text.includes(';W[aa](;B[bb]XX[custom])(;B[cc])'));
});
test('flattening retains turn and stones only, no continuation or historical captures',()=>{
 const text=flattenPosition({board_size:9,errors:[],to_play:'white',stones:[{x:0,y:0,color:'black'},{x:2,y:2,color:'white'}]},DEFAULT_GAME_INFO);
 assert.ok(text.includes('PL[W]AB[aa]AW[cc]'));assert.equal((text.match(/;/g)||[]).length,1);
});
test('disconnected/cyclic tree rejected rather than silently losing branches',()=>{
 assert.throws(()=>serializeTree({...tree,nodes:[...tree.nodes,n('unused',null,[],[])]}));
 assert.throws(()=>serializeTree({...tree,nodes:tree.nodes.map(node=>node.id==='c'?{...node,child_ids:['r']}:node)}));
});
test('undo restores exact SGF, redo is discarded by new edit, save marker survives history',()=>{
 const history=new DocumentHistory({sgfText:'one',nodeId:'r'});
 history.observe({sgfText:'two',nodeId:'a'});assert.equal(history.dirty,true);
 history.move(-1);assert.equal(history.current.sgfText,'one');assert.equal(history.dirty,false);
 history.move(1);history.markSaved();assert.equal(history.dirty,false);
 history.observe({sgfText:'two',nodeId:'b'});history.move(-1);assert.equal(history.dirty,true);
 history.observe({sgfText:'three',nodeId:'r'});assert.equal(history.canRedo,false);
});
test('recent files deduplicate paths and cap length',()=>{
 let entries=[];for(let i=0;i<20;i++)entries=addRecentDocument(entries,{path:`/${i}`,name:String(i),openedAt:i});
 assert.equal(entries.length,12);entries=addRecentDocument(entries,{path:'/19',name:'recent',openedAt:30});assert.equal(entries.length,12);assert.equal(entries[0].name,'recent');
});
test('compressed setup lists expand before erasing a single point',async()=>{
 const {expandSetupPoints}=await import('../src/domain/documentEditing.ts');
 assert.deepEqual(expandSetupPoints(['aa:bb','aa'],9),['aa','ab','ba','bb']);
 assert.throws(()=>expandSetupPoints(['zz'],19));
 assert.throws(()=>expandSetupPoints(['bb:aa'],9));
});
test('drag resolves latest placement after capture/reoccupation and isolates siblings',async()=>{
 const {findStonePlacement}=await import('../src/domain/documentEditing.ts');
 const t={root_id:'r',nodes:[n('r',null,['a'],[p('AB','aa:cc')]),n('a','r',['b','s'],[p('W','dd')]),n('b','a',[],[p('W','aa')]),n('s','a',[],[p('B','aa')])]};
 assert.deepEqual(findStonePlacement(t,'b','aa',9),{nodeId:'b',color:'white',kind:'move'});
 assert.deepEqual(findStonePlacement(t,'s','aa',9),{nodeId:'s',color:'black',kind:'move'});
 assert.deepEqual(findStonePlacement(t,'a','bb',9),{nodeId:'r',color:'black',kind:'setup'});
});
test('inserting before a root-embedded move retains root setup and all continuations',()=>{
 const mixed={root_id:'r',nodes:[n('r',null,['a'],[p('SZ','9'),p('AB','cc'),p('B','aa'),p('C','first move')]),n('a','r',[],[p('W','bb')])]};
 assert.equal(insertMove(mixed,'r','white',{x:3,y:3},9),'(;SZ[9]AB[cc];W[dd];B[aa]C[first move];W[bb])');
});
test('empty new document and unsaved history retain correct save baseline',()=>{
 assert.ok(newGameSgf(DEFAULT_GAME_INFO).startsWith('(;GM[1]FF[4]CA[UTF-8]'));
 const history=new DocumentHistory({sgfText:'(;SZ[19])',nodeId:'r'},false);
 assert.equal(history.dirty,true);history.markSaved();assert.equal(history.dirty,false);
 history.observe({sgfText:'(;SZ[19];B[aa])',nodeId:'a'});history.move(-1);assert.equal(history.dirty,false);
 history.move(1);assert.equal(history.dirty,true);history.markSaved();history.move(-1);assert.equal(history.dirty,true);
});
