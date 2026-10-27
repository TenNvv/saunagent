/** Restrained Pi-inspired palette. Leave body text/background to the terminal. */
export const ui = {
  accent: "#af87d7",
  border: "gray",
  warning: "yellow",
  error: "red",
} as const;

/** Session names stay prominent; reverse video additionally marks selection. */
export function sessionNameStyle(selected = false) {
  return { color: ui.accent, bold: true, inverse: selected } as const;
}

// Status colors remain reserved for exceptional states.
export function taskStatusColor(status: string): string | undefined {
  if (status === "failed") return ui.error;
  if (status === "waiting") return ui.warning;
  return undefined;
}
