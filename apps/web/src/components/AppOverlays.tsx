import {
  Modal as NextModal,
  Popover as NextPopover,
  Dropdown as NextDropdown,
  Tooltip as NextTooltip,
} from '@nextui-org/react';
import type { ComponentProps } from 'react';
import { createContext, useContext, useEffect, useRef } from 'react';

const OverlayLayer = createContext(240);

/** Portals must clear the app's sticky bars, including nested menus. */
export function Modal(props: ComponentProps<typeof NextModal>) {
  const dialog = useRef<HTMLDivElement>(null);
  const open = props.isOpen ?? props.defaultOpen;
  useEffect(() => {
    if (!open) return;
    // Disabling the focused submit button can leave focus on body. Resume the
    // active dialog's keyboard loop without interfering with its nested menus.
    const resumeFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.activeElement !== document.body)
        return;
      const dialogs = [
        ...document.querySelectorAll('.app-dialog[data-open="true"]'),
      ];
      if (!dialog.current || dialogs.at(-1) !== dialog.current) return;
      const controls = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]',
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled, [aria-disabled="true"]') &&
          element.getClientRects().length > 0,
      );
      const target = event.shiftKey ? controls.at(-1) : controls[0];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      target.focus();
    };
    document.addEventListener('keydown', resumeFocus, true);
    return () => document.removeEventListener('keydown', resumeFocus, true);
  }, [open]);
  const slots = {
    wrapper: 'app-dialog-overlay',
    backdrop: 'app-dialog-backdrop',
    base: 'app-dialog',
    header: 'app-dialog-header',
    body: 'app-dialog-body',
    footer: 'app-dialog-footer',
    closeButton: 'app-dialog-close',
  };
  const classNames = { ...props.classNames };
  for (const [slot, name] of Object.entries(slots)) {
    const key = slot as keyof typeof slots;
    classNames[key] = [name, props.classNames?.[key]].filter(Boolean).join(' ');
  }
  return (
    <OverlayLayer.Provider value={320}>
      <NextModal
        {...props}
        ref={dialog}
        placement="center"
        scrollBehavior="inside"
        portalContainer={
          typeof document === 'undefined' ? undefined : document.body
        }
        classNames={classNames}
      />
    </OverlayLayer.Provider>
  );
}

export function Popover(props: ComponentProps<typeof NextPopover>) {
  const zIndex = useContext(OverlayLayer);
  return <NextPopover {...props} style={{ ...props.style, zIndex }} />;
}

export function Dropdown(props: ComponentProps<typeof NextDropdown>) {
  const zIndex = useContext(OverlayLayer);
  return <NextDropdown {...props} style={{ ...props.style, zIndex }} />;
}

export function Tooltip(props: ComponentProps<typeof NextTooltip>) {
  const zIndex = useContext(OverlayLayer) + 10;
  return <NextTooltip {...props} style={{ ...props.style, zIndex }} />;
}
