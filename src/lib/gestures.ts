import { type MouseEvent, type PointerEvent, useCallback, useRef } from "react";

/** Taps on a button inside the row mean the button, not the row. */
function fromControl(e: { target: EventTarget | null }): boolean {
  return e.target instanceof Element && e.target.closest("button, a, input, select, textarea") !== null;
}

/**
 * Opens a row's inline editor the way each device expects: a long press on a phone,
 * a double-click or right-click with a mouse. Pointer devices also get a pencil on
 * hover (see `EditButton`), because nothing on screen hints at a long press.
 */
export function useEditGestures(onEdit: () => void, ms = 600) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(
    (e: PointerEvent) => {
      // A mouse would trigger this by simply resting on a row, so it uses the clicks below.
      if (e.pointerType === "mouse" || fromControl(e)) return;
      cancel();
      timer.current = setTimeout(onEdit, ms);
    },
    [onEdit, ms, cancel],
  );

  const open = useCallback(
    (e: MouseEvent) => {
      if (fromControl(e)) return;
      e.preventDefault();
      onEdit();
    },
    [onEdit],
  );

  return {
    onPointerDown: start,
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onDoubleClick: open,
    onContextMenu: open,
  };
}
