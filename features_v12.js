(() => {
'use strict';
const root=document.getElementById('cards');
if(!root) return;
function clean(){
  root.querySelectorAll('.state').forEach(input=>{
    input.placeholder='';
    input.title='黒板に状態が確認できた場合のみ自動入力します';
  });
  root.querySelectorAll('.contract').forEach(input=>{
    input.title='黒板の委託件名または工事名を読み取ります。必要に応じて手入力できます';
  });
}
clean();
new MutationObserver(clean).observe(root,{childList:true,subtree:true});
})();
