/**
 * @license
 * Copyright 2023 Google LLC.
 * Licensed under the Apache License, Version 2.0
 */

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: string[];
}

/** Max messages kept in the conversation (always whole user/assistant pairs). */
export const AGENT_MAX_MESSAGES = 20;

/** Backend limit per message (agent-runtime MAX_MESSAGE_CHARS). */
export const BACKEND_MAX_MESSAGE_CHARS = 20000;
const TRUNCATION_MARK = '\n[…respuesta anterior recortada…]';

/**
 * Builds the messages sent to the backend: the most recent complete
 * user/assistant pairs (never starting with an assistant turn) plus the new
 * user message, so the total never exceeds AGENT_MAX_MESSAGES. Long assistant
 * replies are truncated only in the request; the visible transcript is
 * untouched and the chat is never blocked by a long reply.
 */
export function buildRequestMessages(
  history: AgentMessage[],
  text: string
): Array<{role: 'user' | 'assistant'; content: string}> {
  let recent = history.slice(-(AGENT_MAX_MESSAGES - 2));
  while (recent.length > 0 && recent[0].role !== 'user') {
    recent = recent.slice(1);
  }
  const clip = (s: string) =>
    s.length > BACKEND_MAX_MESSAGE_CHARS
      ? s.slice(0, BACKEND_MAX_MESSAGE_CHARS - TRUNCATION_MARK.length) +
        TRUNCATION_MARK
      : s;
  return [
    ...recent.map(({role, content}) => ({role, content: clip(content)})),
    {role: 'user', content: text},
  ];
}
