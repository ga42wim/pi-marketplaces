/**
 * Multi-select TUI component for pi-marketplaces.
 *
 * Pi's extension API only offers single-select dialogs (`ctx.ui.select`) and
 * `ctx.ui.custom` for fully custom components. This component provides a
 * checkbox list:
 *
 *   ↑/↓        move the cursor
 *   space      toggle the highlighted item
 *   enter      confirm the selection
 *   escape     cancel (returns null)
 *   a          toggle all
 *
 * It is only usable in TUI mode; RPC/print callers fall back to a sequential
 * select loop (see `pickMany` in index.ts).
 */

import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

export interface MultiSelectItem {
  /** Stable value returned when selected. */
  value: string;
  /** Primary label shown in the list. */
  label: string;
  /** Optional dimmed description shown after the label. */
  description?: string;
  /** Pre-checked state. */
  checked?: boolean;
}

export interface MultiSelectTheme {
  fg(color: string, text: string): string;
}

export class MultiSelect {
  private items: MultiSelectItem[];
  private checked: boolean[];
  private cursor = 0;
  private maxVisible: number;
  private theme: MultiSelectTheme;
  private title: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  /** Called with the selected values when the user confirms. */
  public onDone?: (values: string[]) => void;
  /** Called when the user cancels. */
  public onCancel?: () => void;

  constructor(
    title: string,
    items: MultiSelectItem[],
    theme: MultiSelectTheme,
    maxVisible = 12,
  ) {
    this.title = title;
    this.items = items;
    this.checked = items.map((i) => i.checked ?? false);
    this.theme = theme;
    this.maxVisible = maxVisible;
  }

  private toggleAll() {
    const anyUnchecked = this.checked.some((c) => !c);
    this.checked = this.checked.map(() => anyUnchecked);
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      if (this.cursor > 0) {
        this.cursor--;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.cursor < this.items.length - 1) {
        this.cursor++;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.space)) {
      this.checked[this.cursor] = !this.checked[this.cursor];
      this.invalidate();
    } else if (data === "a" || data === "A") {
      this.toggleAll();
    } else if (matchesKey(data, Key.enter)) {
      this.onDone?.(this.items.filter((_, i) => this.checked[i]).map((i) => i.value));
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
    }
  }

  private visibleRange(): { start: number; end: number } {
    if (this.items.length <= this.maxVisible) return { start: 0, end: this.items.length };
    let start = this.cursor - Math.floor(this.maxVisible / 2);
    start = Math.max(0, Math.min(start, this.items.length - this.maxVisible));
    return { start, end: start + this.maxVisible };
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const { fg } = this.theme;
    const lines: string[] = [];

    lines.push(truncateToWidth(fg("accent", this.title), width));

    const { start, end } = this.visibleRange();
    for (let i = start; i < end; i++) {
      const item = this.items[i];
      const isCursor = i === this.cursor;
      const box = this.checked[i] ? fg("success", "[x]") : fg("dim", "[ ]");
      const pointer = isCursor ? fg("accent", ">") : " ";
      const labelText = isCursor ? fg("accent", item.label) : item.label;
      let line = `${pointer} ${box} ${labelText}`;
      if (item.description) {
        line += "  " + fg("dim", item.description);
      }
      lines.push(truncateToWidth(line, width));
    }

    if (start > 0 || end < this.items.length) {
      lines.push(
        fg("dim", `  (${this.cursor + 1}/${this.items.length})`),
      );
    }

    const selectedCount = this.checked.filter(Boolean).length;
    lines.push("");
    lines.push(
      fg("dim", `  space toggle · enter confirm · a all · esc cancel · ${selectedCount} selected`),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
