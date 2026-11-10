'use strict';
window.NanoMotion = (() => {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = 'cubic-bezier(.16,1,.3,1)';
  function enter(element, y=6) {
    if (!element || reduced()) return;
    element.animate([{opacity:0,transform:`translateY(${y}px)`},{opacity:1,transform:'translateY(0)'}],{duration:240,easing:ease});
  }
  function scrollController(element) {
    let following = true, frame = 0, previous = 0;
    function tick(now) {
      const dt=Math.min((now-(previous || now-16))/1000,.05);previous=now;
      const target=Math.max(0,element.scrollHeight-element.clientHeight);
      const next=element.scrollTop+(target-element.scrollTop)*(1-Math.exp(-23*dt));
      element.scrollTop=Math.abs(target-next)<.8?target:next;
      if(following && Math.abs(target-element.scrollTop)>.8)frame=requestAnimationFrame(tick);else{frame=0;previous=0;}
    }
    function bottom(immediate=false) {
      if(immediate){following=true;cancelAnimationFrame(frame);frame=0;element.scrollTop=element.scrollHeight;return;}
      if(!following)return;
      if(reduced()){element.scrollTop=element.scrollHeight;return;}
      if(!frame)frame=requestAnimationFrame(tick);
    }
    element.addEventListener('wheel',event=>{if(event.deltaY<0){following=false;cancelAnimationFrame(frame);frame=0;}},{passive:true});
    element.addEventListener('touchstart',()=>{following=false;},{passive:true});
    element.addEventListener('pointerdown',event=>{if(event.offsetX>=element.clientWidth-12)following=false;});
    element.addEventListener('scroll',()=>{if(element.scrollHeight-element.scrollTop-element.clientHeight<8)following=true;},{passive:true});
    return {bottom,pause:()=>{following=false;cancelAnimationFrame(frame);frame=0;},get following(){return following;}};
  }
  function autosize(element) {
    const old=element.getBoundingClientRect().height;
    element.style.height='auto';const target=Math.min(element.scrollHeight,170);element.style.height=`${target}px`;
    if(!reduced() && Math.abs(target-old)>2)element.animate([{height:`${old}px`},{height:`${target}px`}],{duration:180,easing:ease});
  }
  document.addEventListener('toggle',event=>{
    const target=event.target;
    if(!target.matches?.('[popover]') || event.newState!=='open')return;
    const trigger=document.querySelector(`[popovertarget="${target.id}"]`);
    if(trigger){const rect=trigger.getBoundingClientRect(),box=target.getBoundingClientRect();const above=['permissionPopover','modePopover','addPopover'].includes(target.id);const x=target.id==='taskPopover'?rect.right-box.width:rect.left;const y=above?rect.top-box.height-9:rect.bottom+7;target.style.left=`${Math.min(Math.max(x,8),innerWidth-box.width-8)}px`;target.style.top=`${Math.min(Math.max(y,8),innerHeight-box.height-8)}px`;target.style.bottom='auto';target.style.right='auto';}
    if(!reduced())target.animate([{opacity:0,transform:'translateY(5px) scale(.985)'},{opacity:1,transform:'none'}],{duration:180,easing:ease});
  },true);
  return {enter,scrollController,autosize};
})();
