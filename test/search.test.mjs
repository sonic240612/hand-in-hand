import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTurns } from '../public/search-ui.js';

const turns=[
  {id:'first',authorId:'a',authorName:'나',status:'completed',createdAt:'2026-09-12T01:00:00Z',prompt:'강조색은 초록색이야',items:[{text:'기억했습니다.'}],tools:[]},
  {id:'second',authorId:'b',authorName:'동료',status:'completed',createdAt:'2026-09-12T02:00:00Z',prompt:'이전 색상으로 수정해 줘',items:[{text:'초록색 버튼을 만들었습니다.'}],tools:[{name:'host_read_file',result:{success:true,output:{content:'<h1>Shared Workspace</h1>'}}}]},
  {id:'third',authorId:'a',authorName:'나',status:'queued',createdAt:'2026-09-12T03:00:00Z',prompt:'같은 세션을 검증해 줘',items:[],tools:[]},
];

test('conversation search matches instructions, public responses and nested tool results',()=>{
  const color=searchTurns(turns,{query:'초록색'});
  assert.deepEqual(color.matches.map(match=>[match.id,match.kind]),[['second','AI 응답'],['first','지시']]);
  const tool=searchTurns(turns,{query:'SHARED workspace'});
  assert.equal(tool.matches[0].id,'second');assert.equal(tool.matches[0].kind,'도구 · host_read_file');
  assert.equal(tool.matches[0].excerpt,'<h1>Shared Workspace</h1>');
  assert.equal(searchTurns(turns,{query:'  '}).total,0);
  assert.equal(searchTurns(turns,{query:'존재하지 않는 내용'}).total,0);
});

test('conversation author and status filters combine and newest results are bounded',()=>{
  assert.deepEqual(searchTurns(turns,{authorId:'a',status:'completed'}).matches.map(match=>match.id),['first']);
  assert.deepEqual(searchTurns(turns,{query:'초록색',authorId:'b'}).matches.map(match=>match.id),['second']);
  assert.equal(searchTurns(turns,{query:'초록색',status:'queued'}).total,0);
  const bounded=searchTurns(turns,{status:'completed'},{limit:1});
  assert.equal(bounded.total,2);assert.equal(bounded.matches.length,1);assert.equal(bounded.matches[0].id,'second');
});

test('search treats input literally and does not mutate history or include private native records',()=>{
  const snapshot=JSON.stringify(turns),source=[{id:'safe',prompt:'[.*] <img src=x onerror=alert(1)>',items:[],tools:[],checkpoint:'private checkpoint phrase'}];
  assert.equal(searchTurns(source,{query:'[.*]'}).total,1);
  assert.equal(searchTurns(source,{query:'<img'}).total,1);
  assert.equal(searchTurns(source,{query:'private checkpoint phrase'}).total,0);
  searchTurns(turns,{query:'color'});assert.equal(JSON.stringify(turns),snapshot);
});

test('oversized tool output has a visible truncation signal, media is skipped and cycles are safe',()=>{
  const circular={text:'visible text'};circular.self=circular;
  const source=[{id:'big',prompt:'',items:[],tools:[{name:'reader',result:{output:{text:'x'.repeat(150)+'needle'}}}]}];
  assert.equal(searchTurns(source,{query:'needle'},{toolBudget:100}).total,0);
  assert.equal(searchTurns(source,{query:'needle'},{toolBudget:100}).truncatedTurns,1);
  assert.equal(searchTurns(source,{query:'needle'},{toolBudget:200}).total,1);
  const media=[{id:'media',prompt:'',items:[],tools:[{name:'view',result:{output:[{type:'image',data:'hidden image needle'},circular]}}]}];
  assert.equal(searchTurns(media,{query:'hidden image needle'}).total,0);
  assert.equal(searchTurns(media,{query:'visible text'}).total,1);
  assert.equal(searchTurns(media,{query:'missing'}).total,0);
});

test('unchanged committed turns reuse search results across reconnect snapshots, changed checkpoints invalidate them',()=>{
  const cache=new Map(),saved={...turns[1],committedRevision:2,completionHash:'saved-one'};
  assert.equal(searchTurns([saved],{query:'shared workspace'},{cache}).total,1);
  const repeated={...saved,get tools(){throw new Error('Committed payload should not be rescanned');}};
  assert.equal(searchTurns([repeated],{query:'shared workspace'},{cache}).total,1);
  const recovered={...saved,completionHash:'saved-two',tools:[]};
  assert.equal(searchTurns([recovered],{query:'shared workspace'},{cache}).total,0);
  assert.equal(searchTurns([saved],{query:'초록색'},{cache}).matches[0].kind,'AI 응답');
});
