
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const PERSONALITIES = {
  friendly: 'You are SCANTY MD BOT, a friendly and helpful WhatsApp assistant. Be warm, clear and concise.',
  professional: 'You are SCANTY MD BOT. Respond professionally, accurately and clearly.',
  funny: 'You are SCANTY MD BOT. Be playful and humorous while remaining helpful.',
  casual: 'You are SCANTY MD BOT. Speak naturally and casually, like a helpful friend.'
};

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 10;

export async function generateAIReply({
  message,
  personality = 'friendly',
  history = []
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('AI is not configured. Add OPENROUTER_API_KEY to Render.');
  }

  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Please provide a message for the AI.');
  }

  const selectedPersonality =
    PERSONALITIES[personality] || PERSONALITIES.friendly;

  const safeHistory = Array.isArray(history)
    ? history
        .filter(
          item =>
            item &&
            ['user', 'assistant'].includes(item.role) &&
            typeof item.content === 'string'
        )
        .slice(-MAX_HISTORY_MESSAGES)
        .map(item => ({
          role: item.role,
          content: item.content.slice(0, MAX_MESSAGE_LENGTH)
        }))
    : [];

  const messages = [
    {
      role: 'system',
      content: selectedPersonality
    },
    ...safeHistory,
    {
      role: 'user',
      content: message.trim().slice(0, MAX_MESSAGE_LENGTH)
    }
  ];

  let response;

  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://scanty-md-bot.onrender.com',
        'X-Title': 'SCANTY MD BOT'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'openrouter/free',
        messages,
        temperature: 0.7,
        max_tokens: 600
      }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('The AI request timed out. Please try again.');
    }

    throw new Error('Could not connect to the AI service.');
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');

    console.error(
      'OpenRouter request failed:',
      response.status,
      errorText.slice(0, 500)
    );

    if (response.status === 401) {
      throw new Error('The AI API key is invalid. Check Render settings.');
    }

    if (response.status === 429) {
      throw new Error('The free AI service is busy. Try again shortly.');
    }

    throw new Error('The AI service is temporarily unavailable.');
  }

  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content;

  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error('The AI returned an empty response. Please try again.');
  }

  return reply.trim();
}
