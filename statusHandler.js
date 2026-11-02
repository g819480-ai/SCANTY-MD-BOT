
import { config } from './config.js';

export function getStatusReaction(contactNumber) {
  if (!config.reactionSettings.enabled) {
    return null;
  }

  if (!config.allowedContacts.includes(contactNumber)) {
    return null;
  }

  const emojis = config.reactionSettings.emojis;

  if (!emojis.length) {
    return null;
  }

  return emojis[Math.floor(Math.random() * emojis.length)];
}
