/**
 * Describes UI interactions for the debug log.
 *
 * Every surface the user can click — the practice view, each modal, the
 * settings tab — funnels its clicks through {@link LogUiClick} so a bug report
 * reads as the literal sequence of controls the user pressed ("clicked
 * `flash-card-flip` labelled Show Answer", "checked the `L2 Hanzi` box"),
 * without every component having to log for itself. Semantic logs (what the
 * click MEANT: a grade, a bank switch) still live at their call sites; this is
 * the raw input track underneath them.
 */

import {Component} from 'obsidian';
import {LogInfo} from './telemetry';

/** How long a control's label may be before the log truncates it. */
const MAX_LABEL = 60;

/**
 * Controls worth logging. A click that lands on plain text or padding is not
 * an action, so it is dropped rather than filling the log with noise.
 */
const CONTROL_SELECTOR =
  'button, input, select, textarea, a, [role="button"], .clickable-icon';

function label(el: HTMLElement): string {
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  if (text.length > 0) {
    return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text;
  }
  // Icon buttons have no text — their tooltip/aria label is the only name.
  return (
    el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '(no label)'
  );
}

/** What kind of control this is, in the terms a reader of the log thinks in. */
function controlKind(el: HTMLElement): string {
  if (el instanceof HTMLInputElement) return `input:${el.type}`;
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  return el.tagName.toLowerCase();
}

/**
 * Identity of the control that was clicked: its kind, label, classes (the
 * `flash-card-flip` / `mc-option` names the rest of the code and the E2E use),
 * every `data-*` attribute (the score a grade button carries, the bank a
 * checkbox belongs to), and its state. Null when the click was not on a
 * control.
 */
export function describeClickTarget(
  target: EventTarget | null,
): Record<string, unknown> | null {
  if (target === null || !(target instanceof Element)) return null;
  const control = target.closest(CONTROL_SELECTOR);
  if (!(control instanceof HTMLElement)) return null;
  const data: Record<string, string> = {};
  for (const key of Object.keys(control.dataset)) {
    data[key] = control.dataset[key] ?? '';
  }
  const described: Record<string, unknown> = {
    control: controlKind(control),
    label: label(control),
    classes: Array.from(control.classList),
    data,
  };
  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    // The state AFTER the click — what the user just turned on or off.
    described['checked'] = control.checked;
  }
  if ('disabled' in control && control.disabled) described['disabled'] = true;
  return described;
}

/**
 * Log one click. `surface` names where it happened (`practice-view`,
 * `modal:add-card`, …) and `context` adds whatever that surface knows about
 * its own state (the card on screen, the bank being edited).
 */
export function LogUiClick(
  surface: string,
  event: Event,
  context: Record<string, unknown> = {},
): void {
  const target = describeClickTarget(event.target);
  if (target === null) return;
  LogInfo('User clicked', {surface, ...target, ...context});
}

/**
 * Click logging for a surface that is NOT a `Component` — Obsidian's `Modal`
 * and `SettingTab` are not, so they have no `registerDomEvent`/`register` of
 * their own and a bare `addEventListener` would never be torn down.
 *
 * This owns a Component so the listener is registered the Obsidian way:
 * `attach()` on open, `unload()` on close, and Obsidian removes it. Views
 * (`ItemView` IS a Component) use `this.registerDomEvent` directly instead.
 */
export class UiClickLogger extends Component {
  private surface: string;
  private context: () => Record<string, unknown>;

  constructor(
    surface: string,
    context: () => Record<string, unknown> = () => ({}),
  ) {
    super();
    this.surface = surface;
    this.context = context;
  }

  /**
   * (Re)attach to a surface's root element. **Idempotent**: unloading first
   * drops the previous listener, so re-rendering a surface onto the SAME
   * element cannot stack duplicates — which the settings tab does constantly
   * (`display()` runs again on every settings open AND after every bank added
   * or removed, on a `containerEl` that is only emptied, never replaced).
   */
  attach(root: HTMLElement): void {
    this.unload();
    this.load();
    this.registerDomEvent(root, 'click', event =>
      LogUiClick(this.surface, event, this.context()),
    );
  }
}
