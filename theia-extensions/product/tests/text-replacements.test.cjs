const {test}=require('node:test');const assert=require('node:assert/strict');
const {replaceText}=require('../lib/node/harness/modules/text-replacements');
test('literal substitutions preserve BOM, CRLF, Unicode, dollar signs and untouched content',()=>{
 const source='\ufeffFROM node:12\r\n# Привет $& / \\\r\n';
 const result=replaceText(source,[{oldText:'node:12',newText:'node:24',expectedMatches:1}]);
 assert.equal(result.content,'\ufeffFROM node:24\r\n# Привет $& / \\\r\n');assert.equal(result.changedOccurrences,1);
 assert.equal(replaceText('aaa $1',[{oldText:'aaa',newText:'$&\\1',expectedMatches:1}]).content,'$&\\1 $1');
});
test('missing and ambiguous fragments, noops, oversized results and script-shaped inputs fail before saving',()=>{
 for(const replacements of [[{oldText:'missing',newText:'new',expectedMatches:1}],[{oldText:'same',newText:'new',expectedMatches:1}],[{oldText:'',newText:'new',expectedMatches:1}],[{oldText:'same',newText:'same',expectedMatches:2}],[{script:'s/same/new/g'}],[{oldText:'same',newText:'x'.repeat(64000),expectedMatches:2}]])assert.throws(()=>replaceText('same same',replacements));
 assert.equal(replaceText('same same',[{oldText:'same',newText:'new',expectedMatches:2}]).content,'new new');
 assert.throws(()=>replaceText('source',[{oldText:'source',newText:'new',expectedMatches:1},{oldText:'missing',newText:'other',expectedMatches:1}]));
});
