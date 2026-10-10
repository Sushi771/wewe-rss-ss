import { ReactNode, useRef, useState } from 'react';
import { motion, useDragControls } from 'framer-motion';

/** Reuse the installed pointer drag implementation; the handle leaves labels clickable. */
export default function FolderDragRow({
  id,
  name,
  disabled,
  onMove,
  children,
}: {
  id: string;
  name: string;
  disabled: boolean;
  onMove: (targetId: string) => void;
  children: ReactNode;
}) {
  const controls = useDragControls();
  const row = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const [dragging, setDragging] = useState(false);
  return (
    <motion.div
      ref={row}
      data-sort-folder={id}
      drag={disabled ? false : 'y'}
      dragListener={false}
      dragControls={controls}
      dragSnapToOrigin
      dragMomentum={false}
      style={{ position: 'relative', zIndex: dragging ? 1 : undefined }}
      onDragStart={() => {
        cancelled.current = false;
        setDragging(true);
      }}
      onDrag={(event) => {
        if (!('clientY' in event)) return;
        const sidebar = row.current?.closest('.feed-sidebar');
        if (!sidebar) return;
        const rect = sidebar.getBoundingClientRect();
        if (event.clientY < rect.top + 36) sidebar.scrollBy(0, -12);
        else if (event.clientY > rect.bottom - 36) sidebar.scrollBy(0, 12);
      }}
      onDragEnd={(event) => {
        setDragging(false);
        if (
          cancelled.current ||
          disabled ||
          event.type === 'pointercancel' ||
          !('clientY' in event)
        )
          return;
        const container = row.current?.closest('.folder-navigation');
        const rect = container?.getBoundingClientRect();
        const viewport = container
          ?.closest('.feed-sidebar')
          ?.getBoundingClientRect();
        if (
          !container ||
          !rect ||
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          return;
        if (
          viewport &&
          (event.clientX < viewport.left ||
            event.clientX > viewport.right ||
            event.clientY < viewport.top ||
            event.clientY > viewport.bottom)
        )
          return;
        const target = Array.from(
          container.querySelectorAll<HTMLElement>('[data-sort-folder]'),
        )
          .filter((node) => node.dataset.sortFolder !== id)
          .find((node) => {
            const box = node.getBoundingClientRect();
            return event.clientY >= box.top && event.clientY <= box.bottom;
          });
        if (target?.dataset.sortFolder) onMove(target.dataset.sortFolder);
      }}
    >
      <div className="flex items-center">
        <button
          type="button"
          disabled={disabled}
          aria-label={`拖动文件夹 ${name} 排序`}
          title="拖动排序；也可使用更多菜单上移/下移。Esc 取消"
          className="shrink-0 px-1 text-neutral-400"
          style={{ touchAction: 'none', cursor: 'grab' }}
          onPointerDown={(event) => {
            if (!disabled) controls.start(event);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              cancelled.current = true;
              setDragging(false);
            }
          }}
        >
          ⠿
        </button>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </motion.div>
  );
}
