'use strict';
(() => {
  const containers = new WeakMap();
  function sync(select) {
    const wrapper=containers.get(select);if(!wrapper)return;
    const button=wrapper.querySelector('button');button.disabled=select.disabled;
    button.querySelector('.select-label').textContent=select.selectedOptions[0]?.textContent || '';
    wrapper.querySelectorAll('[data-option]').forEach(item=>{item.classList.toggle('selected',Number(item.dataset.option)===select.selectedIndex);item.disabled=select.options[Number(item.dataset.option)]?.disabled;});
  }
  function enhance(select) {
    if(containers.has(select))return sync(select);
    const wrapper=document.createElement('div');wrapper.className='custom-select';
    const button=document.createElement('button');button.type='button';button.className='custom-select-trigger';button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const label=document.createElement('span');label.className='select-label';button.append(label);
    const chevron=document.createElement('i');chevron.dataset.lucide='chevron-down';button.append(chevron);
    const menu=document.createElement('div');menu.className='custom-select-menu';menu.setAttribute('role','listbox');menu.hidden=true;
    select.before(wrapper);wrapper.append(select,button,menu);select.classList.add('native-select');containers.set(select,wrapper);
    function rebuild(){menu.replaceChildren();[...select.options].forEach((option,index)=>{const item=document.createElement('button');item.type='button';item.dataset.option=index;item.setAttribute('role','option');item.textContent=option.textContent;item.addEventListener('click',()=>{if(option.disabled)return;select.selectedIndex=index;select.dispatchEvent(new Event('change',{bubbles:true}));menu.hidden=true;button.setAttribute('aria-expanded','false');button.focus();sync(select);});menu.append(item);});sync(select);}
    button.addEventListener('click',()=>{const opening=menu.hidden;document.querySelectorAll('.custom-select-menu').forEach(item=>item.hidden=true);menu.hidden=!opening;button.setAttribute('aria-expanded',String(opening));if(opening)menu.querySelector('.selected')?.focus();});
    wrapper.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.hidden=true;button.setAttribute('aria-expanded','false');button.focus();event.stopPropagation();}if(!menu.hidden && ['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')];const index=items.indexOf(document.activeElement);items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}});
    select.addEventListener('change',()=>sync(select));new MutationObserver(rebuild).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','label']});rebuild();window.lucide?.createIcons();
  }
  function scan(root=document){root.querySelectorAll('select').forEach(enhance);}
  document.addEventListener('click',event=>{if(!event.target.closest('.custom-select'))document.querySelectorAll('.custom-select-menu').forEach(menu=>menu.hidden=true);});
  document.addEventListener('DOMContentLoaded',()=>{scan();new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType!==1)return;if(node.matches('select'))enhance(node);scan(node);}))).observe(document.body,{childList:true,subtree:true});});
  window.NanoSelect={scan,sync};
})();
