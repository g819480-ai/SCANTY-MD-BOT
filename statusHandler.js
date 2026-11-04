import { STATUS_EMOJIS } from './featureSettings.js';

// Legacy helper retained for compatibility.
// The active per-user status handling is in statusEvents.js.
export function getStatusReaction() {
  if (!STATUS_EMOJIS.length) return null;

  return STATUS_EMOJIS[
    Math.floor(Math.random() * STATUS_EMOJIS.length)
  ];
}
