import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
export function SessionComfort({ surface, paused, onPause, context }: { surface: RefObject<HTMLElement | null>; paused: boolean; onPause(value: boolean): void; context: string }) {
  const [reminders, setReminders] = useState(false), [due, setDue] = useState(false);
  const pointers = useRef(new Set<number>()), pending = useRef(false);
  useEffect(() => {
    if (!reminders) { setDue(false); pending.current = false; return; }
    const node = surface.current;
    const down = (event: PointerEvent) => pointers.current.add(event.pointerId);
    const up = (event: PointerEvent) => { pointers.current.delete(event.pointerId); if (!pointers.current.size && pending.current) { pending.current = false; setDue(true); } };
    const clear = () => { pointers.current.clear(); if (pending.current) { pending.current = false; setDue(true); } };
    node?.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up); window.addEventListener('blur', clear);
    const timer = setInterval(() => { if (pointers.current.size) pending.current = true; else setDue(true); }, 45 * 60 * 1000);
    return () => { clearInterval(timer); node?.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); window.removeEventListener('blur', clear); pointers.current.clear(); pending.current = false; };
  }, [reminders, surface]);
  return <details className="utility-panel"><summary>工作上下文与休息</summary><p>{context}</p><p>撤销最多保留 128 次操作、64 MiB；达到任一预算时最旧操作会移出。切图或重建编辑器会清空撤销；这不是永久版本历史。</p><button type="button" aria-pressed={paused} onClick={() => onPause(!paused)}>{paused ? '返回编辑' : '暂停编辑'}</button><p>暂停只阻止当前工作台编辑，不释放任务、不停止保存、不延长 lease，也不恢复已暂停的保存队列；返回时仍检查权限与上下文。</p><label><input type="checkbox" checked={reminders} onChange={event => setReminders(event.target.checked)} />每 45 分钟显示自愿休息提醒（仅本次页面，不记录或上传活动）</label>{due ? <div role="status"><p>可以休息一下；未自动暂停，也不会打断手势。</p><button type="button" onClick={() => setDue(false)}>稍后提醒</button><button type="button" onClick={() => setReminders(false)}>关闭提醒</button></div> : null}</details>;
}
